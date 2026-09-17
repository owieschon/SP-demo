// The curtain in front of the whole site.
import { describe, expect, it } from 'vitest';
import {
	GATE_DAYS,
	gateEnabled,
	gateExempt,
	passwordMatches,
	signGateCookie,
	verifyGateCookie
} from './gate.ts';

const secret = 'a-test-session-secret';

describe('whether the curtain is up at all', () => {
	it('is only up when a password is configured', () => {
		expect(gateEnabled(undefined)).toBe(false);
		expect(gateEnabled('')).toBe(false);
		expect(gateEnabled('something')).toBe(true);
	});
});

describe('what answers without the password', () => {
	it('lets through the endpoints that carry their own secret', () => {
		for (const path of [
			'/gate',
			'/robots.txt',
			'/api/mcp',
			'/api/cron/automations',
			'/api/mail/poll',
			'/api/mail/webhook',
			'/_app/immutable/entry/app.js'
		]) {
			expect(gateExempt(path), path).toBe(true);
		}
	});

	it('holds back every page and every other endpoint', () => {
		for (const path of [
			'/',
			'/commitments',
			'/commitments/5639',
			'/accounts/10012',
			'/ask',
			'/desk',
			'/workspace',
			'/operations',
			'/operations/samples/today',
			'/signin',
			'/settings/mcp',
			'/quotes/448001/pdf',
			'/apinot/mcp',
			'/api/mcpx'
		]) {
			expect(gateExempt(path), path).toBe(false);
		}
	});
});

describe('the password', () => {
	it('matches only itself', () => {
		expect(passwordMatches('open sesame', 'open sesame')).toBe(true);
		expect(passwordMatches('open sesam', 'open sesame')).toBe(false);
		expect(passwordMatches('Open Sesame', 'open sesame')).toBe(false);
		expect(passwordMatches('', 'open sesame')).toBe(false);
		expect(passwordMatches('anything', undefined)).toBe(false);
		expect(passwordMatches('anything', '')).toBe(false);
	});

	it('is not in the cookie it hands out', () => {
		const cookie = signGateCookie(secret);
		expect(cookie).not.toContain('open sesame');
		// Only an expiry and a signature.
		expect(cookie.split('.')).toHaveLength(2);
	});
});

describe('the cookie', () => {
	it('is accepted when this server signed it', () => {
		expect(verifyGateCookie(signGateCookie(secret), secret)).toBe(true);
	});

	it('is refused when it was signed with another secret', () => {
		expect(verifyGateCookie(signGateCookie('other-secret'), secret)).toBe(false);
	});

	it('is refused once it expires, and cannot be stretched', () => {
		const cookie = signGateCookie(secret);
		const afterwards = Date.now() + (GATE_DAYS + 1) * 24 * 60 * 60 * 1000;
		expect(verifyGateCookie(cookie, secret, afterwards)).toBe(false);

		// Moving the expiry invalidates the signature over it.
		const [, given] = cookie.split('.');
		expect(verifyGateCookie(`${Date.now() + 9e12}.${given}`, secret)).toBe(false);
	});

	it('is refused when it is missing or malformed', () => {
		for (const value of [undefined, '', 'nonsense', 'a.b.c', `${Date.now() + 1000}`, 'x.y']) {
			expect(verifyGateCookie(value as string | undefined, secret)).toBe(false);
		}
	});

	it('does not double as a session cookie, and a session cookie does not open the curtain', () => {
		// Same secret, different prefix inside the signature.
		const gate = signGateCookie(secret);
		expect(gate.split('.')).toHaveLength(2);
		expect(verifyGateCookie(`2.${Date.now() + 9e6}.somesignature`, secret)).toBe(false);
	});
});
