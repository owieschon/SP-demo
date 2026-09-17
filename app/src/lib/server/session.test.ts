import { describe, expect, it } from 'vitest';
import { sessionSecret, signSession, verifySession } from './session.ts';

const secret = 'test-secret-that-is-long-enough';
const now = Date.UTC(2026, 8, 17, 15, 0, 0);

describe('session cookie', () => {
	it('round-trips a user id', () => {
		expect(verifySession(signSession(4, secret, now), secret, now)).toBe(4);
	});

	it('rejects a changed user id', () => {
		const [, expiresAt, signature] = signSession(4, secret, now).split('.');
		expect(verifySession(`1.${expiresAt}.${signature}`, secret, now)).toBeNull();
	});

	it('rejects a stretched expiry', () => {
		const [id, expiresAt, signature] = signSession(4, secret, now).split('.');
		expect(verifySession(`${id}.${Number(expiresAt) + 1}.${signature}`, secret, now)).toBeNull();
	});

	it('rejects a cookie signed with another secret', () => {
		expect(verifySession(signSession(4, 'another-secret', now), secret, now)).toBeNull();
	});

	it('rejects an expired cookie', () => {
		const later = now + 8 * 24 * 60 * 60 * 1000;
		expect(verifySession(signSession(4, secret, now), secret, later)).toBeNull();
	});

	it('rejects garbage', () => {
		for (const value of [undefined, '', 'a.b.c', '4', '4.5', '4.5.6.7', '-1.99.x']) {
			expect(verifySession(value, secret, now)).toBeNull();
		}
	});

	it('refuses to run deployed without a secret', () => {
		expect(() => sessionSecret(undefined, true)).toThrow(/SESSION_SECRET/);
		expect(sessionSecret(undefined, false)).toBe(sessionSecret(undefined, false));
		expect(sessionSecret('configured', true)).toBe('configured');
	});
});
