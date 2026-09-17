// Who may wake the desk from outside: the cron and the mail provider.
//
// The cron uses the same shared secret and the same constant-time comparison
// as the nightly automation run (automation/cron.ts), so there is one rule for
// both and not two.
//
// The webhook uses its own secret, MAIL_WEBHOOK_SECRET, sent either as
// "Authorization: Bearer <secret>" or as the x-mail-webhook-secret header.
// Two things about it matter:
//
//   * A webhook body is not trusted for anything except "something arrived".
//     The handler ignores the payload's message and polls the provider
//     instead, so a forged body cannot put a message in the inbox.
//   * AgentMail signs its webhooks with Svix (svix-id, svix-timestamp,
//     svix-signature over the raw body). A shared secret is what this server
//     checks, which is weaker: it proves the caller knows the secret, not
//     that the provider sent this particular body. Because the body is
//     thrown away and the mail is fetched from the provider, that is enough
//     here. A deployment that wanted the stronger guarantee would add the
//     svix verification on top; it is noted in docs/desk-agent.md.
import { createHash, timingSafeEqual } from 'node:crypto';
import { checkCronAccess, type CronAccess } from '../automation/cron.ts';

export type { CronAccess };

/** The cron's own check, reusing the automation rule. */
export function checkMailCronAccess(authorization: string | null, secret: string | undefined): CronAccess {
	return checkCronAccess(authorization, secret);
}

/**
 * The webhook's check. Both header forms are compared in constant time, so
 * the response time says nothing about how many characters were right.
 */
export function checkWebhookAccess(
	headers: { authorization?: string | null; secret?: string | null },
	secret: string | undefined
): CronAccess {
	if (!secret) return 'not_configured';
	const matches = (sent: string | null | undefined, expected: string) => {
		const a = createHash('sha256').update(sent ?? '').digest();
		const b = createHash('sha256').update(expected).digest();
		return timingSafeEqual(a, b);
	};
	// Both forms are always compared, so a caller cannot learn which one the
	// server prefers from how long the answer took.
	const bearer = matches(headers.authorization, `Bearer ${secret}`);
	const plain = matches(headers.secret, secret);
	return bearer || plain ? 'ok' : 'denied';
}

/**
 * The HTTP status an access decision deserves.
 *   200  the caller is allowed
 *   401  the caller got the secret wrong
 *   503  this server has no secret set, so the endpoint is off
 * A server with no secret answers 503 and not 401 on purpose: "off" and
 * "wrong password" are different things, and a deployment checklist needs to
 * be able to tell them apart.
 */
export function accessStatus(access: CronAccess): 200 | 401 | 503 {
	if (access === 'ok') return 200;
	return access === 'not_configured' ? 503 : 401;
}
