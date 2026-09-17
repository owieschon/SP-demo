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
import { LIVE_COOKIE, LIVE_COOKIE_PATH, LIVE_MINUTES, liveConfigured, passphraseMatches, signLiveCookie, verifyLiveCookie } from './live.ts';
import { MOCK_LABEL, mockModel } from './mock.ts';
import { decideProposal } from './proposals.ts';

type Event = Pick<RequestEvent, 'cookies' | 'locals' | 'request'>;

/** Live mode needs the server's key and passphrase, and this person's cookie. */
export function liveState({ cookies, locals }: Pick<Event, 'cookies' | 'locals'>) {
	const values = { apiKey: env.ANTHROPIC_API_KEY, passphrase: env.LIVE_AI_PASSPHRASE, model: env.ANTHROPIC_MODEL };
	const configured = liveConfigured(values) && env.ASSISTANT_MOCK !== '1';
	const secret = sessionSecret(env.SESSION_SECRET, Boolean(env.VERCEL));
	const unlocked = configured && verifyLiveCookie(cookies.get(LIVE_COOKIE), locals.user!.id, secret);
	return { configured, unlocked, model: env.ANTHROPIC_MODEL || DEFAULT_MODEL, secret };
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

// One API client per server, made the first time live mode is used.
let anthropic: Anthropic | null = null;

/** The model that will answer: the real one only when live mode is unlocked. */
function modelFor(event: Pick<Event, 'cookies' | 'locals'>, today: string): AskModel {
	const user = event.locals.user!;
	const live = liveState(event);
	if (!live.unlocked) return mockModel({ userId: user.id });
	anthropic ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
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
	return {
		mode: modeView(event),
		caps: await readCaps(db, event.locals.user!.id, readLimits(env)),
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

	try {
		const result = await askQuestion(
			{ db, userId: user.id, model: modelFor(event, now), limits: readLimits(env), today: now },
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
	const live = liveState(event);
	if (!live.configured) {
		return fail(400, { liveMessage: 'Live mode is not set up on this server.', liveOk: false } satisfies AskFailure);
	}
	const given = String((await event.request.formData()).get('passphrase') ?? '');
	if (!passphraseMatches(given, env.LIVE_AI_PASSPHRASE)) {
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
