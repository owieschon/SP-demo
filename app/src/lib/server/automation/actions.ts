// Form actions for the rule editor (/automations/new and /automations/[id]).
//
// The editor sends the whole rule as one JSON field, `rule`. Each action
// checks it with the catalog's ruleSchema, then calls rules.ts. Every answer
// has the same shape (EditorAnswer), so the page can show it in one place,
// and problems with the rule come back keyed by where they are in it
// ("conditions.0.value") so the editor can show each next to its control.
import { fail, redirect } from '@sveltejs/kit';
import { ruleSchema, type Rule } from '$lib/automation/catalog';
import { friendlyIssues } from '$lib/automation/describe';
import type { EditorAnswer } from '$lib/automation/types';
import type { SessionUser } from '$lib/types';
import type { Db } from '../db/types.ts';
import { toAppError } from '../errors.ts';
import { runRule, saveRule, testRule } from './rules.ts';

type Parsed = { ok: true; rule: Rule; ruleId: number | null; form: FormData } | { ok: false; answer: EditorAnswer };

/** Read the editor's form: the rule (checked against the catalog) and which saved rule it is. */
async function readForm(request: Request, from: EditorAnswer['from']): Promise<Parsed> {
	const form = await request.formData();
	const rawId = String(form.get('ruleId') ?? '');
	const ruleId = rawId === '' ? null : Number(rawId);
	if (ruleId !== null && !(Number.isSafeInteger(ruleId) && ruleId > 0)) {
		return { ok: false, answer: { from, message: 'That rule number is not valid.', failed: true } };
	}

	let json: unknown;
	try {
		json = JSON.parse(String(form.get('rule') ?? ''));
	} catch {
		return { ok: false, answer: { from, message: 'The form is out of date. Reload the page and try again.', failed: true } };
	}

	const parsed = ruleSchema.safeParse(json);
	if (!parsed.success) {
		return {
			ok: false,
			answer: {
				from,
				message: 'Some parts of the rule need fixing first.',
				failed: true,
				issues: friendlyIssues(parsed.error.issues)
			}
		};
	}
	return { ok: true, rule: parsed.data, ruleId, form };
}

/** A refusal from the database as an answer, or rethrow a real failure. */
function refusal(error: unknown, from: EditorAnswer['from']) {
	const known = toAppError(error);
	if (!known) throw error;
	return fail(known.status, {
		from,
		message: known.message,
		failed: true,
		conflict: known.status === 409
	} satisfies EditorAnswer);
}

export async function testAction(db: Db, user: SessionUser, request: Request) {
	const input = await readForm(request, 'test');
	if (!input.ok) return fail(422, input.answer);
	try {
		const test = await testRule(db, user.id, input.rule, input.ruleId);
		return { from: 'test', message: '', failed: false, test } satisfies EditorAnswer;
	} catch (error) {
		return refusal(error, 'test');
	}
}

export async function saveAction(db: Db, user: SessionUser, request: Request) {
	const input = await readForm(request, 'save');
	if (!input.ok) return fail(422, input.answer);
	const version = String(input.form.get('expectedUpdatedAt') ?? '');

	let saved;
	try {
		saved = await saveRule(db, user.id, {
			ruleId: input.ruleId,
			rule: input.rule,
			expectedUpdatedAt: version === '' ? null : version,
			requestId: String(input.form.get('requestId') ?? '')
		});
	} catch (error) {
		return refusal(error, 'save');
	}

	// A new rule opens at its own address.
	if (input.ruleId === null) redirect(303, `/automations/${saved.ruleId}?saved=1`);
	return {
		from: 'save',
		message: input.rule.enabled ? 'Saved. It runs every morning.' : 'Saved. It is switched off, so only "Run now" runs it.',
		failed: false
	} satisfies EditorAnswer;
}

export async function runAction(db: Db, user: SessionUser, request: Request) {
	const form = await request.formData();
	const ruleId = Number(form.get('ruleId'));
	if (!Number.isSafeInteger(ruleId) || ruleId <= 0) {
		return fail(400, { from: 'run', message: 'Save the rule before running it.', failed: true } satisfies EditorAnswer);
	}
	try {
		const run = await runRule(db, user.id, ruleId, 'ui');
		const message = run.error
			? `The run stopped and wrote nothing: ${run.error}`
			: `Matched ${run.matched}. Wrote ${run.fired} new, skipped ${run.skipped} already done.`;
		return { from: 'run', message, failed: run.error !== null, run } satisfies EditorAnswer;
	} catch (error) {
		return refusal(error, 'run');
	}
}
