// The context screens' form actions.
//
// Same pattern as every other feature's forms.ts: check the form's shape with
// zod, call the write, turn a refusal from the database into a message the
// page can show. Nothing a form sends is used as a value to write except the
// id, the row version and the request id: what gets written comes out of the
// stored claim inside the SQL function.
import { fail, type ActionFailure } from '@sveltejs/kit';
import { z } from 'zod';
import type { SessionUser } from '$lib/types';
import { SUBJECT_KINDS } from '$lib/context/types';
import type { Db } from '../db/types.ts';
import { toAppError } from '../errors.ts';
import { runContextBuild } from './build.ts';
import { exploreSources } from './explore.ts';
import { decideEntityLink, decideReviewItem, resolveConflict } from './write.ts';

export type ContextFormFailure = { message: string; conflict?: boolean };
export type ContextFormResult = { message: string } | ActionFailure<ContextFormFailure>;

function formObject(data: FormData): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of data) {
		if (typeof value === 'string') out[key] = value;
	}
	return out;
}

async function run(work: () => Promise<string>): Promise<ContextFormResult> {
	try {
		return { message: await work() };
	} catch (error) {
		const refusal = toAppError(error);
		if (!refusal) throw error;
		return fail(refusal.status, {
			message: refusal.message,
			conflict: refusal.status === 409
		} satisfies ContextFormFailure);
	}
}

const resolveInput = z.object({
	conflictId: z.coerce.number().int().positive(),
	claimId: z.coerce.number().int().positive(),
	rowVersion: z.string().min(10),
	requestId: z.string().min(8).max(100),
	note: z.string().max(500).optional()
});

/** A person choosing between two claims. */
export async function resolveConflictAction(
	db: Db,
	user: SessionUser,
	request: Request
): Promise<ContextFormResult> {
	const parsed = resolveInput.safeParse(formObject(await request.formData()));
	if (!parsed.success) {
		return fail(400, { message: 'Pick one of the two claims.' } satisfies ContextFormFailure);
	}
	const input = parsed.data;
	return run(async () => {
		const result = await resolveConflict(db, user.id, {
			conflictId: input.conflictId,
			claimId: input.claimId,
			note: input.note ?? '',
			rowVersion: input.rowVersion,
			requestId: input.requestId
		});
		return result.replayed
			? 'That was already decided; nothing was written twice.'
			: 'Recorded as your decision. The rule will not change it back.';
	});
}

const reviewInput = z.object({
	itemId: z.coerce.number().int().positive(),
	decision: z.enum(['dismissed', 'resolved']),
	rowVersion: z.string().min(10),
	requestId: z.string().min(8).max(100),
	note: z.string().max(500).optional()
});

export async function decideReviewAction(
	db: Db,
	user: SessionUser,
	request: Request
): Promise<ContextFormResult> {
	const parsed = reviewInput.safeParse(formObject(await request.formData()));
	if (!parsed.success) {
		return fail(400, { message: 'Dismiss it or mark it dealt with.' } satisfies ContextFormFailure);
	}
	const input = parsed.data;
	return run(async () => {
		const result = await decideReviewItem(db, user.id, {
			itemId: input.itemId,
			decision: input.decision,
			note: input.note ?? '',
			rowVersion: input.rowVersion,
			requestId: input.requestId
		});
		if (result.replayed) return 'That was already decided.';
		return input.decision === 'dismissed'
			? 'Dismissed. It stays on the record with its words.'
			: 'Marked as dealt with.';
	});
}

const linkInput = z.object({
	rawKind: z.enum(['name', 'email', 'email_domain', 'phone', 'part_number']),
	rawValue: z.string().trim().min(1).max(200),
	targetKind: z.enum(SUBJECT_KINDS),
	targetId: z.string().trim().min(1).max(40),
	decision: z.enum(['accepted', 'rejected']),
	requestId: z.string().min(8).max(100),
	note: z.string().max(500).optional()
});

/** A person saying which account a raw name or address actually is. */
export async function decideLinkAction(
	db: Db,
	user: SessionUser,
	request: Request
): Promise<ContextFormResult> {
	const parsed = linkInput.safeParse(formObject(await request.formData()));
	if (!parsed.success) {
		return fail(400, { message: 'Say which account this is, or reject it.' } satisfies ContextFormFailure);
	}
	const input = parsed.data;
	return run(async () => {
		const result = await decideEntityLink(db, user.id, {
			rawKind: input.rawKind,
			rawValue: input.rawValue,
			targetKind: input.targetKind,
			targetId: input.targetId,
			decision: input.decision,
			note: input.note ?? '',
			requestId: input.requestId
		});
		if (input.decision === 'rejected') return 'Rejected. Nothing was attached to that account.';
		return result.claims_resolved > 0
			? `Matched. ${result.claims_resolved} claim(s) that were waiting now have a subject.`
			: 'Matched. There were no claims waiting on it.';
	});
}

const exploreInput = z.object({
	entityKind: z.enum(SUBJECT_KINDS),
	entityId: z.string().trim().min(1).max(40),
	attribute: z.string().trim().max(60).optional()
});

/** "Go and look", from the coverage screen or an entity's page. */
export async function exploreAction(
	db: Db,
	user: SessionUser,
	request: Request
): Promise<ContextFormResult> {
	const parsed = exploreInput.safeParse(formObject(await request.formData()));
	if (!parsed.success) {
		return fail(400, { message: 'Say what to explore for.' } satisfies ContextFormFailure);
	}
	const input = parsed.data;
	return run(async () => {
		const report = await exploreSources(
			db,
			user.id,
			{ kind: input.entityKind, id: input.entityId },
			{ attribute: input.attribute || null }
		);
		if (report.claimsWritten === 0 && report.unparsed === 0) {
			return `Read ${report.documentsRead} document(s) and found nothing new. Nothing was written.`;
		}
		const parts = [`Read ${report.documentsRead} document(s)`];
		if (report.claimsWritten > 0) parts.push(`${report.claimsWritten} new claim(s)`);
		if (report.failedValidation > 0) parts.push(`${report.failedValidation} failed validation`);
		if (report.unparsed > 0) parts.push(`${report.unparsed} could not be read`);
		const blocked = report.wouldPromote.filter((row) => row.blocked).length;
		if (blocked > 0) parts.push(`${blocked} need a person`);
		// Said every time, because it is the guarantee: this tool never decides.
		return `${parts.join(', ')}. Claims only: nothing was promoted and nothing was sent.`;
	});
}

/** Run the whole mill, from the coverage screen. */
export async function buildAction(
	db: Db,
	user: SessionUser,
	_request: Request
): Promise<ContextFormResult> {
	void _request;
	return run(async () => {
		const summary = await runContextBuild(db, user.id, { subjects: 12 });
		return (
			`Built in ${(summary.ms / 1000).toFixed(1)}s: explored ${summary.explored} subject(s), ` +
			`${summary.claimsWritten} new claim(s), ${summary.promoted} promoted, ` +
			`${summary.conflictsRaised} raised for a person, ${summary.bundlesChanged} bundle(s) changed.`
		);
	});
}
