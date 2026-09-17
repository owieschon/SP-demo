// Who may start the daily automation run: only a caller that knows
// CRON_SECRET. Vercel's scheduler sends it as "Authorization: Bearer <secret>".
import { createHash, timingSafeEqual } from 'node:crypto';

export type CronAccess = 'ok' | 'not_configured' | 'denied';

/**
 * Compare the header with the secret in constant time, so the response time
 * says nothing about how many characters were right. Both sides are hashed
 * first because timingSafeEqual needs two values of the same length.
 */
export function checkCronAccess(authorization: string | null, secret: string | undefined): CronAccess {
	if (!secret) return 'not_configured';
	const sent = createHash('sha256').update(authorization ?? '').digest();
	const expected = createHash('sha256').update(`Bearer ${secret}`).digest();
	return timingSafeEqual(sent, expected) ? 'ok' : 'denied';
}
