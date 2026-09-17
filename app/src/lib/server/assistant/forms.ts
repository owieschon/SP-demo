// What the two /ask routes do, in one place: work out the mode, answer a
// question, decide a proposal, and switch live mode on and off.
//
// Both routes are thin because everything here needs the same three things:
// the signed-in person, the database, and whether live mode is unlocked for
// them right now.
import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { fail, type ActionFailure, type RequestEvent } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { CapsView, ModeView } from '$lib/assistant/types';
import { getDb } from '../db/index.ts';
import type { Db } from '../db/types.ts';
import { sessionSecret } from '../session.ts';
import { askQuestion } from './ask.ts';
import { readCaps, readLimits } from './caps.ts';
import { AskModelError, DEFAULT_MODEL, liveModel, messagesApi } from './claude.ts';
import { toAskError } from './errors.ts';
import type { AskModel } from './loop.ts';
import { LIVE_COOKIE, LIVE_COOKIE_PATH, LIVE_MINUTES, passphraseMatches, signLiveCookie, verifyLiveCookie } from './live.ts';
import { MOCK_LABEL, mockModel } from './mock.ts';
import { decideProposal } from './proposals.ts';
import { primeSettings, settingOrEnvSync, settingsOverEnv } from '../settings/read.ts';

type Event = Pick<RequestEvent, 'cookies' | 'locals' | 'request'>;

/**
 * Live mode needs the server's key and this person's cookie.
 *
 * The key, the model and the passphrase can now come from Settings as well as
 * from the environment (lib/server/settings/read.ts). settingOrEnvSync reads a
 * short-lived cache that primeSettings() fills wherever this file already
 * talks to the database; with nothing stored it returns the environment
 * variable, which is what this did before.
 *
 * The passphrase is optional now. When one is set it still has to be typed.
 * When Settings leaves it blank, a key alone puts everyone signed in on the
 * real model, bounded by the daily caps, which is what the Settings page says
 * out loud.
 */
export function liveState({ cookies, locals }: Pick<Event, 'cookies' | 'locals'>) {
	const apiKey = settingOrEnvSync('anthropic_api_key');
	const passphrase = settingOrEnvSync('live_ai_passphrase');
	const configured = Boolean(apiKey) && env.ASSISTANT_MOCK !== '1';
	const secret = sessionSecret(env.SESSION_SECRET, Boolean(env.VERCEL));
	const unlocked =
		configured && (!passphrase || verifyLiveCookie(cookies.get(LIVE_COOKIE), locals.user!.id, secret));
	return { configured, unlocked, model: settingOrEnvSync('anthropic_model') || DEFAULT_MODEL, secret };
}

/**
 * What the badge says. Scripted demo mode is the default and never claims to
 * be the real model.
 */
export function modeView(event: Pick<Event, 'cookies' | 'locals'>): ModeView {
	const live = liveState(event);
	return {
		mode: live.unlocked ? 'live' : 'mock',
		label: live.unlocked ? live.model : MOCK_LABEL,
		model: live.unlocked ? live.model : null,
		configured: live.configured,
		unlocked: live.unlocked
	};
}

// One API client per server, made the first time live mode is used. The key it
// was made with is kept beside it, so a key changed in Settings makes a new
// client instead of being ignored until the next deploy.
let anthropic: Anthropic | null = null;
let anthropicKey: string | undefined;

/** The model that will answer: the real one only when live mode is unlocked. */
function modelFor(event: Pick<Event, 'cookies' | 'locals'>, today: string): AskModel {
	const user = event.locals.user!;
	const live = liveState(event);
	if (!live.unlocked) return mockModel({ userId: user.id });
	const key = settingOrEnvSync('anthropic_api_key');
	if (!anthropic || anthropicKey !== key) {
		anthropic = new Anthropic({ apiKey: key });
		anthropicKey = key;
	}
	return liveModel({
		api: messagesApi(anthropic),
		model: live.model,
		who: { name: user.fullName, role: user.role },
		today
	});
}

export interface AskPageData {
	mode: ModeView;
	caps: CapsView;
	requestId: string;
}

/** The parts of the page that both routes need. */
export async function askPageData(event: Pick<Event, 'cookies' | 'locals'>): Promise<AskPageData> {
	const db = await getDb();
	// Load what Settings holds before anything reads it synchronously below.
	await primeSettings(db);
	return {
		mode: modeView(event),
		caps: await readCaps(db, event.locals.user!.id, readLimits(settingsOverEnv())),
		// Fresh on each load: sending the same form twice answers once.
		requestId: randomUUID()
	};
}

export type AskFailure = {
	message?: string;
	/** True when the day's calls are used up, so the page can say it calmly. */
	capped?: boolean;
	liveMessage?: string;
	liveOk?: boolean;
};

async function today(db: Db, userId: number): Promise<string> {
	const [row] = await db.asUser(userId, (tx) => tx.sql<{ today: string }>`select nl.today() as today`);
	return row.today;
}

export interface AskAnswer {
	conversationId: number;
	answered: true;
}

/** Answer one question, in a new conversation or an existing one. */
export async function askAction(event: Event): Promise<AskAnswer | ActionFailure<AskFailure>> {
	const user = event.locals.user!;
	const form = await event.request.formData();
	const db = await getDb();
	const now = await today(db, user.id);
	await primeSettings(db);

	try {
		const result = await askQuestion(
			{ db, userId: user.id, model: modelFor(event, now), limits: readLimits(settingsOverEnv()), today: now },
			{
				question: String(form.get('question') ?? ''),
				conversationId: form.get('conversationId') ? String(form.get('conversationId')) : null,
				requestId: String(form.get('requestId') ?? '')
			}
		);
		return { conversationId: result.conversationId, answered: true };
	} catch (error) {
		// The live model refusing, running out of room or failing is news the
		// person can act on, not a crash.
		if (error instanceof AskModelError) return fail(502, { message: error.message });
		const refusal = toAskError(error);
		if (refusal) return fail(refusal.status, { message: refusal.message, capped: refusal.status === 429 });
		throw error;
	}
}

export interface DecideAnswer {
	message: string;
	decided: true;
}

/** Approve or reject a proposal. */
export async function decideAction(event: Event): Promise<DecideAnswer | ActionFailure<AskFailure>> {
	const user = event.locals.user!;
	const form = await event.request.formData();
	const db = await getDb();
	const value = (name: string) => {
		const raw = form.get(name);
		return raw === null || raw === '' ? undefined : String(raw);
	};

	try {
		const result = await decideProposal(db, user.id, {
			proposalId: value('proposalId'),
			conversationId: value('conversationId'),
			decision: value('decision'),
			optionIndex: value('optionIndex') ?? null,
			reason: value('reason') ?? '',
			expectedUpdatedAt: value('expectedUpdatedAt'),
			requestId: value('requestId'),
			shownTool: value('shownTool'),
			shownInput: value('shownInput')
		});
		return { message: result.message, decided: true };
	} catch (error) {
		const refusal = toAskError(error);
		if (refusal) return fail(refusal.status, { message: refusal.message });
		throw error;
	}
}

/** Unlock live mode for an hour. The passphrase never comes back to the page. */
export async function unlockAction(event: Event) {
	// Settings may hold the passphrase, so load it before reading it.
	await primeSettings(await getDb());
	const live = liveState(event);
	if (!live.configured) {
		return fail(400, { liveMessage: 'Live mode is not set up on this server.', liveOk: false } satisfies AskFailure);
	}
	const given = String((await event.request.formData()).get('passphrase') ?? '');
	if (!passphraseMatches(given, settingOrEnvSync('live_ai_passphrase'))) {
		// A short pause makes guessing slow.
		await new Promise((resolve) => setTimeout(resolve, 600));
		return fail(403, { liveMessage: 'That passphrase is not right.', liveOk: false } satisfies AskFailure);
	}
	event.cookies.set(LIVE_COOKIE, signLiveCookie(event.locals.user!.id, live.secret), {
		path: LIVE_COOKIE_PATH,
		httpOnly: true,
		sameSite: 'strict',
		maxAge: LIVE_MINUTES * 60
	});
	return { liveMessage: `Live mode is on for ${LIVE_MINUTES} minutes.`, liveOk: true };
}

export function lockAction(event: Pick<Event, 'cookies'>) {
	event.cookies.delete(LIVE_COOKIE, { path: LIVE_COOKIE_PATH });
	return { liveMessage: 'Live mode is off. Scripted demo mode answers from here on.', liveOk: true };
}
