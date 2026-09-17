// Settings and the admin passcode against a real database.
//
// One small world for the whole file, "today" pinned to 2026-09-17. The order
// of the groups matters: an instance can only be claimed once, so the tests
// before the claim run first, and the tests that change the passcode run last.
//
// Each group that guesses the passcode wrong uses its own person, because the
// rate limit counts wrong answers per person for fifteen minutes and there is
// no way to wind that clock back.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runReadOnlySql } from '../assistant/sql.ts';
import { createTestDb } from '../db/pglite.ts';
import type { Db } from '../db/types.ts';
import { AppError } from '../errors.ts';
import { changePasscode, checkPasscode, claimInstance, PasscodeRefused, readLockState } from './admin.ts';
import { decryptSecret } from './crypto.ts';
import { readDiagnostics } from './diagnostics.ts';
import { SETTING_KEYS } from './keys.ts';
import {
	invalidateSettings,
	loadSettings,
	readSettingStatus,
	rowVersions,
	settingOrEnv,
	type SettingsEnv
} from './read.ts';
import { clearSetting, saveSetting } from './write.ts';

const ADMIN = 1;
const DANA = 2;
const MARCUS = 3;
const GUESSER = 4; // only ever guesses wrong, so the rate limit stays out of the way

const PASSCODE = 'a long enough passphrase';
const SECOND_PASSCODE = 'another long passphrase';
const API_KEY = 'sk-ant-notreal-0000-abcd';
const ENV_KEY = 'sk-ant-fromenvironment-9999';

let db: Db;

/** The environment this module is handed, so no test depends on the real one. */
const env: SettingsEnv = {
	record: {
		ANTHROPIC_API_KEY: ENV_KEY,
		ANTHROPIC_MODEL: 'claude-from-environment',
		ASSISTANT_DAILY_PER_USER: '11',
		SESSION_SECRET: 'a-session-secret-for-tests'
	},
	sessionSecret: 'a-session-secret-for-tests'
};

const rid = () => randomUUID();

/** Every write claims a request id and leaves an audit row; this counts them. */
async function auditRows(entity: string, entityId: string): Promise<number> {
	const [row] = await db.asUser(ADMIN, (tx) => tx.sql<{ n: number }>`
		select count(*)::int as n from nl.audit_log where entity = ${entity} and entity_id = ${entityId}`);
	return row.n;
}

async function save(userId: number, key: string, value: string) {
	const versions = await rowVersions(db, env);
	return saveSetting(
		db,
		userId,
		{ key: key as (typeof SETTING_KEYS)[number], value, expectedUpdatedAt: versions[key] ?? null, requestId: rid() },
		env
	);
}

async function clear(userId: number, key: string) {
	const versions = await rowVersions(db, env);
	return clearSetting(db, userId, {
		key: key as (typeof SETTING_KEYS)[number],
		expectedUpdatedAt: versions[key] ?? '',
		requestId: rid()
	});
}

beforeAll(async () => {
	db = await createTestDb();
});

afterAll(async () => {
	await db?.close();
});

beforeEach(() => {
	// The read cache lives for a few seconds, which is longer than a test.
	invalidateSettings();
});

describe('before anyone has claimed the instance', () => {
	it('has the same list of settings as the app', async () => {
		const [row] = await db.asUser(ADMIN, (tx) => tx.sql<{ keys: string[] }>`select nl.setting_keys() as keys`);
		expect([...row.keys].sort()).toEqual([...SETTING_KEYS].sort());
	});

	it('says nobody owns it', async () => {
		const lock = await readLockState(db, ADMIN);
		expect(lock.claimed).toBe(false);
		expect(lock.salt).toBeNull();
	});

	it('refuses to store a setting at all', async () => {
		await expect(save(ADMIN, 'anthropic_model', 'claude-opus-5')).rejects.toMatchObject({
			status: 403
		});
	});

	it('refuses the passcode check, because there is nothing to check against', async () => {
		await expect(checkPasscode(db, ADMIN, PASSCODE, rid())).rejects.toBeInstanceOf(PasscodeRefused);
	});

	it('falls back to the environment for every setting', async () => {
		expect(await settingOrEnv(db, 'anthropic_api_key', env)).toBe(ENV_KEY);
		expect(await settingOrEnv(db, 'agentmail_api_key', env)).toBeUndefined();
	});
});

describe('claiming the instance', () => {
	it('takes the first passcode and records who set it', async () => {
		const before = await auditRows('instance', 'northline');
		await claimInstance(db, ADMIN, PASSCODE, rid());
		const lock = await readLockState(db, ADMIN);
		expect(lock.claimed).toBe(true);
		expect(lock.claimedBy).toBe(ADMIN);
		expect(lock.salt).not.toBeNull();
		expect(await auditRows('instance', 'northline')).toBe(before + 1);
	});

	it('refuses a passcode that is too short', async () => {
		await expect(claimInstance(db, DANA, 'short', rid())).rejects.toBeInstanceOf(PasscodeRefused);
	});

	it('cannot be claimed a second time, by anyone', async () => {
		await expect(claimInstance(db, ADMIN, 'yet another passphrase', rid())).rejects.toMatchObject({ status: 409 });
		await expect(claimInstance(db, MARCUS, 'someone elses passphrase', rid())).rejects.toMatchObject({ status: 409 });
		// Still the first person's.
		expect((await readLockState(db, ADMIN)).claimedBy).toBe(ADMIN);
	});

	it('never stores the passcode itself', async () => {
		const [row] = await db.asSystem((tx) => tx.sql<{ hash: string; salt: string }>`
			select passcode_hash as hash, salt from nl_config.admin_lock`);
		expect(row.hash).not.toContain('passphrase');
		expect(row.hash).toHaveLength(64);
		expect(row.salt).not.toContain('passphrase');
	});
});

describe('the passcode', () => {
	it('unlocks when it is right, and records the attempt', async () => {
		const result = await checkPasscode(db, ADMIN, PASSCODE, rid());
		expect(result.ok).toBe(true);
		expect(result.locked).toBe(false);
		const [row] = await db.asSystem((tx) => tx.sql<{ n: number }>`
			select count(*)::int as n from nl_config.admin_attempts where user_id = ${ADMIN} and ok`);
		expect(row.n).toBeGreaterThanOrEqual(1);
	});

	it('is refused when it is wrong, with the tries left, and leaves a record', async () => {
		const before = await auditRows('instance', 'northline');
		const result = await checkPasscode(db, MARCUS, 'not the passcode at all', rid());
		expect(result.ok).toBe(false);
		expect(result.locked).toBe(false);
		expect(result.attemptsLeft).toBe(4);
		expect(result.message).toContain('not the passcode');
		// A wrong answer is recorded, which is what makes the rate limit work.
		expect(await auditRows('instance', 'northline')).toBe(before + 1);
		const [row] = await db.asSystem((tx) => tx.sql<{ n: number }>`
			select count(*)::int as n from nl_config.admin_attempts where user_id = ${MARCUS} and not ok`);
		expect(row.n).toBe(1);
	});

	it('locks that person out after five wrong answers in fifteen minutes', async () => {
		const left: number[] = [];
		for (let i = 0; i < 5; i++) {
			const result = await checkPasscode(db, GUESSER, `guess number ${i}`, rid());
			expect(result.ok).toBe(false);
			left.push(result.attemptsLeft);
		}
		expect(left).toEqual([4, 3, 2, 1, 0]);

		// The sixth is not even compared, and does not extend the lock.
		const locked = await checkPasscode(db, GUESSER, `guess number 5`, rid());
		expect(locked.ok).toBe(false);
		expect(locked.locked).toBe(true);
		expect(locked.minutes).toBeGreaterThan(0);
		expect(locked.message).toContain('Too many wrong answers');

		// Even the right passcode waits.
		const right = await checkPasscode(db, GUESSER, PASSCODE, rid());
		expect(right.ok).toBe(false);
		expect(right.locked).toBe(true);

		// Only five wrong answers were counted, not seven.
		const [row] = await db.asSystem((tx) => tx.sql<{ n: number }>`
			select count(*)::int as n from nl_config.admin_attempts where user_id = ${GUESSER}`);
		expect(row.n).toBe(5);

		// One person's lock is their own: somebody else can still unlock.
		expect((await checkPasscode(db, DANA, PASSCODE, rid())).ok).toBe(true);
	});

	it('answers the same request id once, instead of counting a retry twice', async () => {
		const requestId = rid();
		const first = await checkPasscode(db, MARCUS, 'wrong again', requestId);
		const [before] = await db.asSystem((tx) => tx.sql<{ n: number }>`
			select count(*)::int as n from nl_config.admin_attempts where user_id = ${MARCUS}`);
		const second = await checkPasscode(db, MARCUS, 'wrong again', requestId);
		const [after] = await db.asSystem((tx) => tx.sql<{ n: number }>`
			select count(*)::int as n from nl_config.admin_attempts where user_id = ${MARCUS}`);
		expect(first.ok).toBe(false);
		expect(second.ok).toBe(false);
		expect(after.n).toBe(before.n);
	});
});

describe('storing a setting', () => {
	it('saves a value, leaves an audit row, and can be read back', async () => {
		const before = await auditRows('setting', 'anthropic_model');
		await save(ADMIN, 'anthropic_model', 'claude-opus-5');
		expect(await auditRows('setting', 'anthropic_model')).toBe(before + 1);
		expect(await settingOrEnv(db, 'anthropic_model', env)).toBe('claude-opus-5');
	});

	it('takes over from the environment variable, and gives it back when cleared', async () => {
		expect(await settingOrEnv(db, 'anthropic_api_key', env)).toBe(ENV_KEY);
		await save(ADMIN, 'anthropic_api_key', API_KEY);
		invalidateSettings();
		expect(await settingOrEnv(db, 'anthropic_api_key', env)).toBe(API_KEY);

		await clear(ADMIN, 'anthropic_api_key');
		invalidateSettings();
		expect(await settingOrEnv(db, 'anthropic_api_key', env)).toBe(ENV_KEY);
	});

	it('stores a secret encrypted, never as itself', async () => {
		await save(ADMIN, 'anthropic_api_key', API_KEY);
		const [row] = await db.asSystem((tx) => tx.sql<{ secret: string; value: string | null; last4: string }>`
			select secret, value, last4 from nl_config.settings where key = 'anthropic_api_key'`);
		expect(row.secret).not.toContain(API_KEY);
		expect(row.value).toBeNull();
		expect(row.last4).toBe('abcd');
		// The server can read it back, because it has the session secret.
		expect(decryptSecret(row.secret, env.sessionSecret)).toBe(API_KEY);
	});

	it('reports a stored secret as unreadable when the session secret has changed', async () => {
		invalidateSettings();
		const rotated: SettingsEnv = { record: {}, sessionSecret: 'a-completely-different-secret' };
		const rows = await loadSettings(db, rotated);
		const key = rows.get('anthropic_api_key');
		expect(key?.unreadable).toBe(true);
		expect(key?.value).toBeUndefined();
		invalidateSettings();
	});

	it('refuses a value that does not make sense for its key', async () => {
		await expect(save(ADMIN, 'anthropic_model', 'Not A Model Name!')).rejects.toMatchObject({ status: 422 });
		await expect(save(ADMIN, 'assistant_daily_per_user', 'lots')).rejects.toMatchObject({ status: 422 });
		await expect(save(ADMIN, 'mail_inbox_orders', 'not-an-address')).rejects.toMatchObject({ status: 422 });
		await expect(save(ADMIN, 'anthropic_api_key', 'nope')).rejects.toBeInstanceOf(AppError);
	});

	it('tidies the allowed recipients list into one comparable shape', async () => {
		await save(ADMIN, 'mail_allowlist', 'Two@Desk.example\none@desk.example, one@desk.example');
		invalidateSettings();
		expect(await settingOrEnv(db, 'mail_allowlist', env)).toBe('one@desk.example,two@desk.example');
	});

	it('refuses a save from a page that was loaded before somebody else saved', async () => {
		const stale = await rowVersions(db, env);
		await save(ADMIN, 'anthropic_model', 'claude-opus-5');
		await expect(
			saveSetting(
				db,
				DANA,
				{
					key: 'anthropic_model',
					value: 'claude-something-else',
					expectedUpdatedAt: stale.anthropic_model ?? null,
					requestId: rid()
				},
				env
			)
		).rejects.toMatchObject({ status: 409 });
	});

	it('refuses a save that thinks nothing is stored when something is', async () => {
		await expect(
			saveSetting(
				db,
				ADMIN,
				{ key: 'anthropic_model', value: 'claude-opus-5', expectedUpdatedAt: null, requestId: rid() },
				env
			)
		).rejects.toMatchObject({ status: 409 });
	});

	it('leaves an audit row when a setting is cleared, without the secret in it', async () => {
		await save(ADMIN, 'cron_secret', 'a-scheduled-run-secret-0001');
		const before = await auditRows('setting', 'cron_secret');
		await clear(ADMIN, 'cron_secret');
		expect(await auditRows('setting', 'cron_secret')).toBe(before + 1);
		const rows = await db.asUser(ADMIN, (tx) => tx.sql<{ detail: Record<string, unknown> }>`
			select detail from nl.audit_log where entity = 'setting' and entity_id = 'cron_secret'`);
		expect(JSON.stringify(rows)).not.toContain('a-scheduled-run-secret-0001');
	});
});

describe('what the browser is allowed to see', () => {
	it('gets whether a secret is set, its last four characters and when, and nothing else', async () => {
		await save(ADMIN, 'anthropic_api_key', API_KEY);
		invalidateSettings();
		const status = await readSettingStatus(db, env);
		const key = status.find((row) => row.key === 'anthropic_api_key')!;
		expect(key.source).toBe('stored');
		expect(key.shown).toBe('abcd');
		expect(key.updatedAt).not.toBeNull();
		// The whole payload, however it is read, holds no key.
		expect(JSON.stringify(status)).not.toContain(API_KEY);
		expect(JSON.stringify(status)).not.toContain(ENV_KEY);
		expect(Object.keys(key).sort()).toEqual(
			['envName', 'isSecret', 'key', 'shown', 'source', 'unreadable', 'updatedAt'].sort()
		);
	});

	it('reads the view nl.settings without a secret in it, even as the app role', async () => {
		await save(ADMIN, 'anthropic_api_key', API_KEY);
		const rows = await db.asUser(ADMIN, (tx) => tx.sql`select * from nl.settings where key = 'anthropic_api_key'`);
		expect(rows).toHaveLength(1);
		expect(Object.keys(rows[0]).sort()).toEqual(
			['is_secret', 'is_set', 'key', 'last4', 'updated_at', 'updated_by', 'value'].sort()
		);
		expect(rows[0].value).toBeNull();
		expect(rows[0].is_set).toBe(true);
		expect(rows[0].last4).toBe('abcd');
		expect(JSON.stringify(rows)).not.toContain(API_KEY);
	});

	it('shows a value that is not secret, because that is the point of it', async () => {
		await save(ADMIN, 'anthropic_model', 'claude-opus-5');
		invalidateSettings();
		const status = await readSettingStatus(db, env);
		expect(status.find((row) => row.key === 'anthropic_model')?.shown).toBe('claude-opus-5');
	});

	it('does not send the last four characters of a key kept in the environment as the value', async () => {
		invalidateSettings();
		await clear(ADMIN, 'anthropic_api_key');
		invalidateSettings();
		const status = await readSettingStatus(db, env);
		const key = status.find((row) => row.key === 'anthropic_api_key')!;
		expect(key.source).toBe('environment');
		expect(key.shown).toBe(ENV_KEY.slice(-4));
		expect(key.shown.length).toBeLessThanOrEqual(4);
		await save(ADMIN, 'anthropic_api_key', API_KEY);
	});
});

describe("the assistant's read-only SQL tool", () => {
	it('cannot read the settings, whichever way it asks', async () => {
		for (const sql of [
			'select * from nl.settings',
			'select * from nl_config.settings',
			'select secret from nl_config.settings',
			'select * from nl.settings_with_secrets()',
			'select nl.admin_lock_state()',
			'select * from nl_config.admin_lock'
		]) {
			const result = await runReadOnlySql(db, sql);
			expect(result, sql).toHaveProperty('error');
		}
	});

	it('can still read the business book, so nothing else was broken', async () => {
		const result = await runReadOnlySql(db, 'select count(*) as n from nl.customers');
		expect(result).not.toHaveProperty('error');
	});
});

describe('the health checks', () => {
	it('report the world without any secret in them', async () => {
		await save(ADMIN, 'anthropic_api_key', API_KEY);
		invalidateSettings();
		const diagnostics = await readDiagnostics(db, ADMIN, env);
		const json = JSON.stringify(diagnostics);
		expect(json).not.toContain(API_KEY);
		expect(json).not.toContain(ENV_KEY);
		expect(json).not.toContain(PASSCODE);
		expect(json).not.toContain(env.sessionSecret);

		// And they say something useful.
		const byId = new Map(diagnostics.checks.map((check) => [check.id, check]));
		expect(byId.get('claimed')?.state).toBe('good');
		expect(byId.get('drift_delivery')?.state).toBe('good');
		expect(byId.get('drift_cost')?.state).toBe('good');
		expect(byId.get('unreadable')?.state).toBe('good');
		expect(diagnostics.counts.find((row) => row.table === 'customers')?.rows).toBeGreaterThan(0);
		// The environment is reported as set or not set, never as a value.
		const apiKeyFlag = diagnostics.environment.find((row) => row.name === 'ANTHROPIC_API_KEY')!;
		expect(apiKeyFlag.set).toBe(true);
		expect(apiKeyFlag.shown).toBe('');
	});

	it('say what to do when something is red', async () => {
		const diagnostics = await readDiagnostics(db, ADMIN, { record: {}, sessionSecret: 'x' });
		const sessionCheck = diagnostics.checks.find((check) => check.id === 'session_secret')!;
		expect(sessionCheck.state).toBe('bad');
		expect(sessionCheck.advice).toContain('SESSION_SECRET');
		// A rotated session secret is called out, not hidden.
		expect(diagnostics.checks.find((check) => check.id === 'unreadable')?.state).toBe('bad');
	});
});

// Last, because it changes the passcode everything above used.
describe('changing the passcode', () => {
	it('refuses somebody who cannot type the old one', async () => {
		const lock = await readLockState(db, ADMIN);
		const result = await changePasscode(db, GUESSER + 1, {
			oldPasscode: 'not the passcode',
			newPasscode: SECOND_PASSCODE,
			expectedUpdatedAt: lock.updatedAt!,
			requestId: rid()
		});
		expect(result.ok).toBe(false);
		// The old passcode still works.
		expect((await checkPasscode(db, DANA, PASSCODE, rid())).ok).toBe(true);
	});

	it('refuses a new passcode that is too short, and one that is the same as the old', async () => {
		const lock = await readLockState(db, ADMIN);
		await expect(
			changePasscode(db, ADMIN, {
				oldPasscode: PASSCODE,
				newPasscode: 'tooshort',
				expectedUpdatedAt: lock.updatedAt!,
				requestId: rid()
			})
		).rejects.toBeInstanceOf(PasscodeRefused);
		// The same phrase again. A fresh salt makes it look different to the
		// database, so this one is caught in the app (admin.ts).
		await expect(
			changePasscode(db, ADMIN, {
				oldPasscode: PASSCODE,
				newPasscode: PASSCODE,
				expectedUpdatedAt: lock.updatedAt!,
				requestId: rid()
			})
		).rejects.toBeInstanceOf(PasscodeRefused);
	});

	it('changes it for whoever knows it, and leaves an audit row', async () => {
		const lock = await readLockState(db, ADMIN);
		const before = await auditRows('instance', 'northline');
		const result = await changePasscode(db, ADMIN, {
			oldPasscode: PASSCODE,
			newPasscode: SECOND_PASSCODE,
			expectedUpdatedAt: lock.updatedAt!,
			requestId: rid()
		});
		expect(result.ok).toBe(true);
		expect(await auditRows('instance', 'northline')).toBeGreaterThan(before);

		expect((await checkPasscode(db, DANA, SECOND_PASSCODE, rid())).ok).toBe(true);
		expect((await checkPasscode(db, DANA, PASSCODE, rid())).ok).toBe(false);
	});

	it('refuses a change from a page loaded before the last one', async () => {
		const stale = await readLockState(db, ADMIN);
		await changePasscode(db, ADMIN, {
			oldPasscode: SECOND_PASSCODE,
			newPasscode: 'a third long passphrase',
			expectedUpdatedAt: stale.updatedAt!,
			requestId: rid()
		});
		await expect(
			changePasscode(db, ADMIN, {
				oldPasscode: 'a third long passphrase',
				newPasscode: 'a fourth long passphrase',
				expectedUpdatedAt: stale.updatedAt!,
				requestId: rid()
			})
		).rejects.toMatchObject({ status: 409 });
	});
});
