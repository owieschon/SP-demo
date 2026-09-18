// The order desk: the inbox on one side, the review queue on the other, and
// the one way a request gets in that did not arrive as mail.
//
// Reading is streamed (the lists come back as promises the page awaits), and
// every action is a form post: check mail, enter a request by hand, approve,
// edit and approve, reject, try sending again.
//
// Checking mail also writes the run trail for whatever the agent worked, from
// the record the agent itself kept (see
// $lib/server/agentruns/desk.ts). A trail that cannot be written never fails
// the poll: the work is already done and recorded either way.
import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { fail, redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { getDb } from '$lib/server/db';
import { recordPollTrails } from '$lib/server/agentruns/desk';
import { enterQuoteRequest } from '$lib/server/agentruns/handentry';
import { approveAction, rejectAction, retryAction } from '$lib/server/desk/forms';
import { chooseClient, listMailboxes, pollAll } from '$lib/server/desk/poll';
import { listMailboxViews, listMessages, listQueue } from '$lib/server/desk/read';
import { parseAllowlist } from '$lib/server/desk/send';
import { ACCEPTED_EXTENSIONS } from '$lib/server/documents/read';
import { extractRequest } from '$lib/server/documents/request';
import { draftsHolding } from '$lib/server/documents/store';
import { toAppError } from '$lib/server/errors';
import { DEFAULT_MODEL, ExtractionError, messagesApi } from '$lib/server/rfq/claude';
import { requestFromForm } from '$lib/server/rfq/forms';
import {
	LIVE_COOKIE,
	LIVE_MINUTES,
	liveConfigured,
	passphraseMatches,
	signLiveCookie,
	verifyLiveCookie
} from '$lib/server/rfq/live';
import { SAMPLES } from '$lib/server/rfq/samples';
import { sessionSecret } from '$lib/server/session';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

/** The mailbox filter in the query string, when it names one this person can see. */
function mailboxFilter(url: URL): number | null {
	const value = Number(url.searchParams.get('desk'));
	return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Live reading needs the server's key and passphrase, and this person's
 * unlock cookie. Without all three, a hand-entered request is read by the
 * rules extractor and no API is called.
 */
function liveState({ cookies, locals }: Pick<RequestEvent, 'cookies' | 'locals'>) {
	const configured = liveConfigured({
		apiKey: env.ANTHROPIC_API_KEY,
		passphrase: env.LIVE_AI_PASSPHRASE,
		model: env.ANTHROPIC_MODEL
	});
	const secret = sessionSecret(env.SESSION_SECRET, Boolean(env.VERCEL));
	const unlocked = configured && verifyLiveCookie(cookies.get(LIVE_COOKIE), locals.user!.id, secret);
	return { configured, unlocked, model: env.ANTHROPIC_MODEL || DEFAULT_MODEL, secret };
}

export const load: PageServerLoad = async ({ locals, url, cookies }) => {
	const user = locals.user!;
	const db = await getDb();
	const allowlist = parseAllowlist(env.MAIL_ALLOWLIST);
	const only = mailboxFilter(url);
	const live = liveState({ cookies, locals });

	// The counts are awaited: the page's header is about them, and a header
	// that arrives after the lists reads as a glitch.
	const mailboxes = await listMailboxViews(db, user.id);

	return {
		mailboxes,
		only,
		// Not awaited: the page shows skeleton rows until these arrive.
		messages: listMessages(db, user.id, { mailboxId: only, limit: 40 }),
		queue: listQueue(db, user.id, allowlist, { mailboxId: only, status: 'open', limit: 40 }),
		provider: {
			live: Boolean(env.AGENTMAIL_API_KEY),
			label: env.AGENTMAIL_API_KEY ? 'AgentMail' : 'scripted demo mailbox'
		},
		allowlist: { empty: allowlist.empty, describe: allowlist.describe },
		// For entering a request by hand: the formats the reader accepts and
		// the invented samples, so the demo needs no typing.
		entry: {
			accept: ACCEPTED_EXTENSIONS.join(','),
			samples: SAMPLES.map((s) => ({ name: s.name, label: s.label, text: s.text })),
			live: { configured: live.configured, unlocked: live.unlocked, model: live.unlocked ? live.model : null }
		},
		requestId: randomUUID()
	};
};

async function sendOptions(userId: number) {
	const db = await getDb();
	const mailboxes = await listMailboxes(db);
	return {
		db,
		client: await chooseClient(db, env, mailboxes, userId),
		allowlist: parseAllowlist(env.MAIL_ALLOWLIST)
	};
}

// One API client per server, made the first time live reading is used.
let anthropic: Anthropic | null = null;

export const actions: Actions = {
	// Fetch what has arrived and let the agent work anything nobody has worked.
	check: async ({ locals, url }) => {
		const user = locals.user!;
		const db = await getDb();
		const mailboxes = await listMailboxes(db);
		if (mailboxes.length === 0) {
			return fail(422, { message: 'No desks are set up on this database.' });
		}
		const client = await chooseClient(db, env, mailboxes, user.id);
		const summaries = await pollAll(db, { client, mode: 'mock', only: mailboxFilter(url) ?? undefined });

		// The trail, per desk, as the desk's own reviewer: the same person the
		// agent worked as.
		await recordPollTrails(
			db,
			mailboxes,
			summaries,
			(address) => `Mail arrived at ${address}, checked from the desk`
		);

		const delivered = summaries.reduce((sum, s) => sum + s.delivered, 0);
		const worked = summaries.reduce((sum, s) => sum + s.runs.length, 0);
		const held = summaries.reduce(
			(sum, s) => sum + s.runs.filter((run) => run.outcome === 'needs_person').length,
			0
		);
		const problem = summaries.find((s) => s.error !== null);
		if (problem) {
			return fail(502, { message: `${problem.label}: ${problem.error}` });
		}
		return {
			message:
				worked === 0
					? delivered === 0
						? 'Nothing new, and nothing left unworked.'
						: `${delivered} new, nothing to work.`
					: `${delivered} new. The agent worked ${worked} ${worked === 1 ? 'message' : 'messages'}` +
						`${held > 0 ? `, ${held} of which need you` : ''}. Nothing has been sent.`
		};
	},

	/*
	  A request somebody took on the telephone.

	  It is the same desk item as an emailed one, read by the same extractor
	  and checked by the same validation, and its source says a person typed
	  it. No reply is drafted, because nobody emailed in.
	*/
	enter: async ({ locals, request, cookies }) => {
		const user = locals.user!;
		const data = await request.formData();
		const read = await requestFromForm(data);
		if (!read.ok) return fail(400, { entryMessage: read.message });

		const db = await getDb();
		const mailboxes = await listMailboxViews(db, user.id);
		const wanted = Number(data.get('desk'));
		const mailbox = mailboxes.find((m) => m.id === wanted) ?? mailboxes.find((m) => m.kind === 'orders');
		if (!mailbox) {
			return fail(422, { entryMessage: 'No desks are set up on this database.' });
		}
		if (!mailbox.active) {
			return fail(422, { entryMessage: `${mailbox.label} is switched off.` });
		}

		const live = liveState({ cookies, locals });
		const requestId = String(data.get('requestId') ?? '') || randomUUID();
		const [{ today }] = await db.asUser(user.id, (tx) => tx.sql<{ today: string }>`select nl.today() as today`);

		// A file this person has already read is the same request coming round
		// again, which is worth saying instead of making a second draft of it.
		const held = await draftsHolding(db, user.id, read.stored.map((file) => file.sha256));
		if (held.size > 0) {
			const named = read.stored
				.filter((file) => held.has(file.sha256))
				.map((file) => `${file.fileName} was already read into R-${held.get(file.sha256)}`);
			return fail(400, { entryMessage: `${named.join(', ')}. Open that request, or leave the file off.` });
		}

		try {
			const extraction = live.unlocked
				? await extractRequest(read.documents, {
						mode: 'claude',
						today,
						claude: {
							api: messagesApi((anthropic ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }))),
							model: live.model
						}
					})
				: await extractRequest(read.documents, { mode: 'rules', today });

			const entered = await enterQuoteRequest(db, user.id, {
				mailboxId: mailbox.id,
				mailboxAddress: mailbox.address,
				mailboxLabel: mailbox.label,
				mailboxKind: mailbox.kind,
				disclosure: mailbox.disclosure,
				from: String(data.get('from') ?? '').trim(),
				fromName: String(data.get('fromName') ?? '').trim(),
				subject: String(data.get('subject') ?? '').trim() || read.sourceName,
				documents: read.documents,
				stored: read.stored,
				sourceName: read.sourceName,
				extraction,
				requestId
			});
			redirect(303, `/desk/${entered.messageId}`);
		} catch (error) {
			if (error instanceof ExtractionError) return fail(502, { entryMessage: error.message });
			const refusal = toAppError(error);
			if (refusal) return fail(refusal.status, { entryMessage: refusal.message });
			throw error;
		}
	},

	// Unlock live reading for an hour. The passphrase never comes back.
	unlock: async ({ locals, request, cookies }) => {
		const live = liveState({ cookies, locals });
		if (!live.configured) {
			return fail(400, { liveMessage: 'Live reading is not set up on this server.', liveOk: false });
		}
		const given = String((await request.formData()).get('passphrase') ?? '');
		if (!passphraseMatches(given, env.LIVE_AI_PASSPHRASE)) {
			// A short pause makes guessing slow.
			await new Promise((resolve) => setTimeout(resolve, 600));
			return fail(403, { liveMessage: 'That passphrase is not right.', liveOk: false });
		}
		cookies.set(LIVE_COOKIE, signLiveCookie(locals.user!.id, live.secret), {
			path: '/desk',
			httpOnly: true,
			sameSite: 'strict',
			maxAge: LIVE_MINUTES * 60
		});
		return { liveMessage: `Live reading is on for ${LIVE_MINUTES} minutes.`, liveOk: true };
	},

	lock: async ({ cookies }) => {
		cookies.delete(LIVE_COOKIE, { path: '/desk' });
		return { liveMessage: 'Live reading is off.', liveOk: true };
	},

	approve: async ({ locals, request }) => {
		const options = await sendOptions(locals.user!.id);
		return approveAction(options.db, locals.user!.id, await request.formData(), { ...options, send: true });
	},

	// Record the decision and stop, for a desk that would rather send in a batch.
	approveOnly: async ({ locals, request }) => {
		const options = await sendOptions(locals.user!.id);
		return approveAction(options.db, locals.user!.id, await request.formData(), { ...options, send: false });
	},

	retry: async ({ locals, request }) => {
		const options = await sendOptions(locals.user!.id);
		return retryAction(options.db, locals.user!.id, await request.formData(), options);
	},

	reject: async ({ locals, request }) => {
		return rejectAction(await getDb(), locals.user!.id, await request.formData());
	}
};
