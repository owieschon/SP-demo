// /settings: the API keys, the mail desks, the scheduled run, and health.
//
// Who may change anything here is the whole point of this page, so it is worth
// being exact. Signing in to this app needs no password, so being the admin
// proves nothing. What proves something is the admin passcode: the first
// person to arrive claims the instance with one, and after that every change
// needs a twelve hour cookie that only the right passcode can set
// (lib/server/settings/admin.ts, docs/settings.md).
//
// Anyone signed in can open this page. Without the passcode they see the
// Health section and nothing else they could change.
import { randomUUID } from 'node:crypto';
import { fail, type RequestEvent } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { getDb } from '$lib/server/db';
import { toAppError } from '$lib/server/errors';
import { sessionSecret } from '$lib/server/session';
import {
	ADMIN_COOKIE,
	ADMIN_COOKIE_PATH,
	ADMIN_HOURS,
	changePasscode,
	checkPasscode,
	claimInstance,
	PasscodeRefused,
	readLockState,
	signAdminCookie,
	verifyAdminCookie
} from '$lib/server/settings/admin';
import { readDiagnostics } from '$lib/server/settings/diagnostics';
import { MIN_PASSCODE_LENGTH } from '$lib/server/settings/keys';
import { readSettingStatus, rowVersions } from '$lib/server/settings/read';
import { clearInput, clearSetting, saveSetting, settingInput } from '$lib/server/settings/write';
import type { Actions, PageServerLoad } from './$types';

/** The secret the admin cookie is signed with: the same one the session cookie uses. */
function secretFor(): string {
	return sessionSecret(env.SESSION_SECRET, Boolean(env.VERCEL));
}

/** Is Settings unlocked on this browser, for this person? */
function unlockedFor(event: Pick<RequestEvent, 'cookies' | 'locals'>): boolean {
	return verifyAdminCookie(event.cookies.get(ADMIN_COOKIE), event.locals.user!.id, secretFor());
}

export const load: PageServerLoad = async ({ cookies, locals }) => {
	// hooks.server.ts guarantees somebody is signed in on this page.
	const user = locals.user!;
	const db = await getDb();
	const lock = await readLockState(db, user.id);
	const unlocked = lock.claimed && verifyAdminCookie(cookies.get(ADMIN_COOKIE), user.id, secretFor());

	return {
		claimed: lock.claimed,
		claimedAt: lock.claimedAt,
		passcodeUpdatedAt: lock.updatedAt,
		unlocked,
		unlockHours: ADMIN_HOURS,
		minPasscode: MIN_PASSCODE_LENGTH,
		// Never a secret: whether it is set, its last four characters, when it changed.
		settings: await readSettingStatus(db),
		// The row version per key, so a save from a page somebody left open is refused.
		versions: await rowVersions(db),
		// Fresh ids for this page load. The forms also make a new one per submit
		// (see the enhance handler in +page.svelte), so a second try is a second
		// write rather than a replay of the first.
		requestIds: {
			claim: randomUUID(),
			unlock: randomUUID(),
			passcode: randomUUID(),
			save: randomUUID(),
			clear: randomUUID()
		},
		// Not awaited: the page arrives first and the health checks stream in.
		diagnostics: readDiagnostics(db, user.id)
	};
};

type Answer = {
	from: 'claim' | 'unlock' | 'passcode' | 'save' | 'clear';
	message: string;
	ok: boolean;
	/** Which setting the answer belongs to, so it shows next to that field. */
	key?: string;
};

function refusal(from: Answer['from'], error: unknown, key?: string) {
	if (error instanceof PasscodeRefused) {
		return fail(422, { from, message: error.message, ok: false, key } satisfies Answer);
	}
	const app = toAppError(error);
	if (!app) throw error;
	return fail(app.status, { from, message: app.message, ok: false, key } satisfies Answer);
}

/** Every write here needs the passcode, whoever is signed in. */
function needsPasscode(from: Answer['from'], key?: string) {
	return fail(403, {
		from,
		message: 'This needs the admin passcode. Unlock Settings and try again.',
		ok: false,
		key
	} satisfies Answer);
}

function requestIdOf(form: FormData): string {
	return String(form.get('requestId') ?? '');
}

export const actions: Actions = {
	// First run: choose the passcode that owns this instance from here on.
	claim: async (event) => {
		const form = await event.request.formData();
		const passcode = String(form.get('passcode') ?? '');
		const again = String(form.get('again') ?? '');
		if (passcode !== again) {
			return fail(422, { from: 'claim', message: 'The two passcodes are not the same.', ok: false } satisfies Answer);
		}
		const db = await getDb();
		try {
			await claimInstance(db, event.locals.user!.id, passcode, requestIdOf(form));
		} catch (error) {
			return refusal('claim', error);
		}
		// Whoever claimed it is unlocked straight away: they just typed it.
		event.cookies.set(ADMIN_COOKIE, signAdminCookie(event.locals.user!.id, secretFor()), {
			path: ADMIN_COOKIE_PATH,
			httpOnly: true,
			sameSite: 'strict',
			maxAge: ADMIN_HOURS * 60 * 60
		});
		return {
			from: 'claim' as const,
			ok: true,
			message: `This instance is yours. Settings are unlocked on this browser for ${ADMIN_HOURS} hours.`
		};
	},

	// Type the passcode: five wrong answers in fifteen minutes and this person waits.
	unlock: async (event) => {
		const form = await event.request.formData();
		const db = await getDb();
		let attempt;
		try {
			attempt = await checkPasscode(db, event.locals.user!.id, String(form.get('passcode') ?? ''), requestIdOf(form));
		} catch (error) {
			return refusal('unlock', error);
		}
		if (!attempt.ok) {
			// A slow answer makes guessing tedious on top of the counted limit.
			await new Promise((resolve) => setTimeout(resolve, 600));
			return fail(attempt.locked ? 429 : 403, {
				from: 'unlock',
				message: attempt.message,
				ok: false
			} satisfies Answer);
		}
		event.cookies.set(ADMIN_COOKIE, signAdminCookie(event.locals.user!.id, secretFor()), {
			path: ADMIN_COOKIE_PATH,
			httpOnly: true,
			sameSite: 'strict',
			maxAge: ADMIN_HOURS * 60 * 60
		});
		return { from: 'unlock' as const, ok: true, message: attempt.message };
	},

	lock: async (event) => {
		event.cookies.delete(ADMIN_COOKIE, { path: ADMIN_COOKIE_PATH });
		return { from: 'unlock' as const, ok: true, message: 'Settings are locked again on this browser.' };
	},

	// Change the passcode. The old one is compared in the database, so knowing
	// it is what allows this, not having the cookie.
	passcode: async (event) => {
		if (!unlockedFor(event)) return needsPasscode('passcode');
		const form = await event.request.formData();
		const next = String(form.get('passcode') ?? '');
		if (next !== String(form.get('again') ?? '')) {
			return fail(422, { from: 'passcode', message: 'The two new passcodes are not the same.', ok: false } satisfies Answer);
		}
		const db = await getDb();
		try {
			const result = await changePasscode(db, event.locals.user!.id, {
				oldPasscode: String(form.get('old') ?? ''),
				newPasscode: next,
				expectedUpdatedAt: String(form.get('expectedUpdatedAt') ?? ''),
				requestId: requestIdOf(form)
			});
			if (!result.ok) {
				await new Promise((resolve) => setTimeout(resolve, 600));
				return fail(result.locked ? 429 : 403, { from: 'passcode', message: result.message, ok: false } satisfies Answer);
			}
			return { from: 'passcode' as const, ok: true, message: result.message };
		} catch (error) {
			return refusal('passcode', error);
		}
	},

	save: async (event) => {
		const form = await event.request.formData();
		const key = String(form.get('key') ?? '');
		if (!unlockedFor(event)) return needsPasscode('save', key);
		const expected = String(form.get('expectedUpdatedAt') ?? '');
		const parsed = settingInput.safeParse({
			key,
			value: String(form.get('value') ?? ''),
			expectedUpdatedAt: expected === '' ? null : expected,
			requestId: requestIdOf(form)
		});
		if (!parsed.success) {
			return fail(400, {
				from: 'save',
				key,
				ok: false,
				message: parsed.error.issues[0]?.message ?? 'Something in the form is missing.'
			} satisfies Answer);
		}
		try {
			const saved = await saveSetting(await getDb(), event.locals.user!.id, parsed.data);
			return {
				from: 'save' as const,
				key,
				ok: true,
				message: saved.last4 ? `Saved. It ends ${saved.last4}.` : 'Saved.'
			};
		} catch (error) {
			return refusal('save', error, key);
		}
	},

	clear: async (event) => {
		const form = await event.request.formData();
		const key = String(form.get('key') ?? '');
		if (!unlockedFor(event)) return needsPasscode('clear', key);
		const parsed = clearInput.safeParse({
			key,
			expectedUpdatedAt: String(form.get('expectedUpdatedAt') ?? ''),
			requestId: requestIdOf(form)
		});
		if (!parsed.success) {
			return fail(400, {
				from: 'clear',
				key,
				ok: false,
				message: parsed.error.issues[0]?.message ?? 'Something in the form is missing.'
			} satisfies Answer);
		}
		try {
			await clearSetting(await getDb(), event.locals.user!.id, parsed.data);
			return { from: 'clear' as const, key, ok: true, message: 'Cleared. The environment variable is used again.' };
		} catch (error) {
			return refusal('clear', error, key);
		}
	}
};
