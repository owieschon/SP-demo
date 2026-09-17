import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { fail, redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { getDb } from '$lib/server/db';
import { toAppError } from '$lib/server/errors';
import { sessionSecret } from '$lib/server/session';
import { ACCEPTED_EXTENSIONS } from '$lib/server/documents/read';
import { extractRequest } from '$lib/server/documents/request';
import { draftsHolding } from '$lib/server/documents/store';
import { DEFAULT_MODEL, ExtractionError, messagesApi } from '$lib/server/rfq/claude';
import { createDraft, listDrafts } from '$lib/server/rfq/drafts';
import { requestFromForm } from '$lib/server/rfq/forms';
import { LIVE_COOKIE, LIVE_MINUTES, liveConfigured, passphraseMatches, signLiveCookie, verifyLiveCookie } from '$lib/server/rfq/live';
import { SAMPLES } from '$lib/server/rfq/samples';
import type { Extraction } from '$lib/server/rfq/schema';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

// Live mode needs the server's key and passphrase, and this person's unlock cookie.
function liveState({ cookies, locals }: Pick<RequestEvent, 'cookies' | 'locals'>) {
	const envValues = { apiKey: env.ANTHROPIC_API_KEY, passphrase: env.LIVE_AI_PASSPHRASE, model: env.ANTHROPIC_MODEL };
	const configured = liveConfigured(envValues);
	const secret = sessionSecret(env.SESSION_SECRET, Boolean(env.VERCEL));
	const unlocked = configured && verifyLiveCookie(cookies.get(LIVE_COOKIE), locals.user!.id, secret);
	return { configured, unlocked, model: env.ANTHROPIC_MODEL || DEFAULT_MODEL, secret };
}

export const load: PageServerLoad = async ({ locals, cookies }) => {
	const user = locals.user!;
	const live = liveState({ cookies, locals });
	return {
		// Not awaited: the page shows skeleton rows until the list arrives.
		drafts: listDrafts(await getDb(), user.id),
		samples: SAMPLES.map((s) => ({ name: s.name, label: s.label, text: s.text })),
		// One list of accepted formats, shared by the reader and the file input.
		accept: ACCEPTED_EXTENSIONS.join(','),
		live: { configured: live.configured, unlocked: live.unlocked, model: live.unlocked ? live.model : null },
		requestId: randomUUID()
	};
};

// One API client per server, made the first time live mode is used.
let anthropic: Anthropic | null = null;

export const actions: Actions = {
	// Read an emailed request, with whatever was attached to it, and store the
	// validated draft, then open it.
	extract: async ({ locals, request, cookies }) => {
		const user = locals.user!;
		const data = await request.formData();
		const read = await requestFromForm(data);
		if (!read.ok) return fail(400, { message: read.message });
		const requestId = String(data.get('requestId') ?? '');

		const live = liveState({ cookies, locals });
		const db = await getDb();
		const [{ today }] = await db.asUser(user.id, (tx) => tx.sql<{ today: string }>`select nl.today() as today`);

		// A file this person has already read is the same request coming round
		// again, which is worth saying instead of making a second draft of it.
		const held = await draftsHolding(db, user.id, read.stored.map((file) => file.sha256));
		if (held.size > 0) {
			const named = read.stored
				.filter((file) => held.has(file.sha256))
				.map((file) => `${file.fileName} was already read into R-${held.get(file.sha256)}`);
			return fail(400, { message: `${named.join(', ')}. Open that draft, or leave the file off.` });
		}

		let draftId: number;
		try {
			const extraction: Extraction & { sourceText: string } = live.unlocked
				? await extractRequest(read.documents, {
						mode: 'claude',
						today,
						claude: { api: messagesApi((anthropic ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }))), model: live.model }
					})
				: await extractRequest(read.documents, { mode: 'rules', today });
			const result = await createDraft(db, user.id, {
				source: extraction.sourceText,
				sourceName: read.sourceName,
				extraction,
				attachments: read.stored,
				requestId
			});
			draftId = result.draftId;
		} catch (error) {
			if (error instanceof ExtractionError) return fail(502, { message: error.message });
			const refusal = toAppError(error);
			if (refusal) return fail(refusal.status, { message: refusal.message });
			throw error;
		}
		redirect(303, `/rfq/${draftId}`);
	},

	// Unlock live mode for an hour. The passphrase never comes back to the page.
	unlock: async ({ locals, request, cookies }) => {
		const live = liveState({ cookies, locals });
		if (!live.configured) return fail(400, { liveMessage: 'Live mode is not set up on this server.', liveOk: false });
		const given = String((await request.formData()).get('passphrase') ?? '');
		if (!passphraseMatches(given, env.LIVE_AI_PASSPHRASE)) {
			// A short pause makes guessing slow.
			await new Promise((resolve) => setTimeout(resolve, 600));
			return fail(403, { liveMessage: 'That passphrase is not right.', liveOk: false });
		}
		cookies.set(LIVE_COOKIE, signLiveCookie(locals.user!.id, live.secret), {
			path: '/rfq',
			httpOnly: true,
			sameSite: 'strict',
			maxAge: LIVE_MINUTES * 60
		});
		return { liveMessage: `Live mode is on for ${LIVE_MINUTES} minutes.`, liveOk: true };
	},

	lock: async ({ cookies }) => {
		cookies.delete(LIVE_COOKIE, { path: '/rfq' });
		return { liveMessage: 'Live mode is off.', liveOk: true };
	}
};
