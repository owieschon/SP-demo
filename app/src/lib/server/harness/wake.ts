// Waking an agent through the harness, which is the only path on which the
// autonomy level means anything.
//
// The feature does the work. The harness decides what happens to the result:
//
//   1. the desk polls and works its messages, exactly as it does today;
//   2. for each run, the harness names the guardrails that stopped it, records
//      the size of what it wrote, and reads the level for that kind of work;
//   3. planRun() says hold, queue, act, or act now;
//   4. acting goes through the FEATURE'S OWN write functions, as the person
//      the agent runs as, so every existing check still applies: the request
//      id, the row version, who may approve, the allowlist, the audit row;
//   5. an action taken alone is recorded with the authority it used and the
//      window to undo it.
//
// Nothing here writes a business record by hand. The harness has no privileges
// the desk does not have; what it has is the level, the pause and the record.
import { randomUUID } from 'node:crypto';
import type { Db, Tx } from '../db/types.ts';
import { AppError, guarded, toAppError } from '../errors.ts';
import { LOW_CONFIDENCE } from '../desk/classify.ts';
import type { MailClient } from '../desk/mail.ts';
import { listMailboxes, pollMailbox, type MailboxRow, type PollOptions, type PollSummary } from '../desk/poll.ts';
import type { RunResult } from '../desk/run.ts';
import { sendApproved, type Allowlist } from '../desk/send.ts';
import { approveDraft, markFailed, rejectDraft } from '../desk/writes.ts';
import type { RunResult as RuleRunResult } from '$lib/automation/types';
import { runRule, testRule } from '../automation/rules.ts';
import { classifyFailure, recordDegradation, type DegradeReason } from './degrade.ts';
import { firstFailure, type GuardrailInput } from './guardrails.ts';
import { planRun, readAutonomy } from './ladder.ts';
import {
	claimUndo,
	finishUndo,
	recordAction as recordActionTx,
	recordArtifact,
	recordEvent,
	type ActionInput,
	type ActionRecorded
} from './record.ts';
import type { Autonomy, Level, Plan } from './types.ts';

// ---------------------------------------------------------------------------
// The order desk
// ---------------------------------------------------------------------------

export interface WakeOptions {
	client: MailClient;
	allowlist: Allowlist;
	mode?: 'mock' | 'live';
	model?: string | null;
	classify?: PollOptions['classify'];
	/** One mailbox only. */
	only?: number;
	maxRuns?: number;
	/** Injected so a test can make the provider or the database fail. */
	poll?: (db: Db, mailbox: MailboxRow, options: PollOptions) => Promise<PollSummary>;
	send?: typeof sendApproved;
	requestId?: string;
}

export interface WakeOutcome {
	runKey: string;
	agent: string;
	workKind: string;
	messageId: number;
	draftId: number | null;
	level: Level;
	plan: Plan;
	/** It approved on its own authority. */
	acted: boolean;
	actionId: number | null;
	undoUntil: string | null;
	sent: boolean;
	providerMessageId: string | null;
	simulated: boolean;
	sampled: boolean;
	guardrail: string | null;
	degraded: DegradeReason | null;
	note: string;
}

export interface WakeSummary {
	mailbox: string;
	label: string;
	delivered: number;
	duplicates: number;
	outcomes: WakeOutcome[];
	/** The provider or the database could not be reached. */
	error: string | null;
	degraded: DegradeReason | null;
}

interface DraftFacts {
	id: number;
	subject: string;
	body: string;
	intent: string;
	status: string;
	blockedReason: string;
	to: string[];
	cc: string[];
	updatedAt: string;
}

async function readDraft(tx: Tx, draftId: number): Promise<DraftFacts | null> {
	const [row] = await tx.sql<{
		id: number;
		subject: string;
		body: string;
		intent: string;
		status: string;
		blocked_reason: string;
		to_addresses: string[];
		cc_addresses: string[];
		updated_at: Date | string;
	}>`
		select id, subject, body, intent, status, blocked_reason, to_addresses, cc_addresses, updated_at
		from nl.mail_drafts where id = ${draftId}`;
	if (!row) return null;
	return {
		id: Number(row.id),
		subject: row.subject,
		body: row.body,
		intent: row.intent,
		status: row.status,
		blockedReason: row.blocked_reason ?? '',
		to: row.to_addresses ?? [],
		cc: row.cc_addresses ?? [],
		updatedAt: new Date(row.updated_at).toISOString()
	};
}

/**
 * Which named guardrail stopped this run. The desk already applied the rule;
 * this reads its own record of what happened and says which check it was, so
 * the ladder can count them.
 */
function nameTheGuardrail(
	run: RunResult,
	draft: DraftFacts | null
): { id: string; verdict: 'refuse' | 'needs_person'; reason: string } | null {
	const blocked = draft?.blockedReason ?? '';

	// A policy refusal names itself in the run's own list.
	if (run.policyRefusals.length > 0) {
		const amount = run.policyRefusals.find((r) => r.includes('which is not one of the figures it verified'));
		return amount
			? { id: 'amount_traceable', verdict: 'refuse', reason: amount }
			: { id: 'disclosure_policy', verdict: 'refuse', reason: run.policyRefusals[0] };
	}
	if (blocked.includes('instructions to an automated system')) {
		return { id: 'instruction_shaped_mail', verdict: 'needs_person', reason: blocked };
	}
	if (run.confidence < LOW_CONFIDENCE) {
		return {
			id: 'confidence_floor',
			verdict: 'needs_person',
			reason: `The classifier was only ${Math.round(run.confidence * 100)}% sure, so it asks.`
		};
	}
	if (blocked.length > 0) {
		return { id: 'nothing_needs_review', verdict: 'refuse', reason: blocked };
	}
	// Anything else the desk sent to a person is a question only the sender can
	// answer, which is the sender_resolved check in practice.
	if (run.outcome === 'needs_person') {
		return {
			id: 'sender_resolved',
			verdict: 'needs_person',
			reason: 'The desk had a question for the sender that only a person should ask.'
		};
	}
	return null;
}

/** One finished desk run, put through the ladder. */
async function applyToRun(
	db: Db,
	mailbox: MailboxRow,
	run: RunResult,
	options: WakeOptions,
	request: string
): Promise<WakeOutcome> {
	const agent = mailbox.kind === 'orders' ? 'order_desk' : 'procurement_desk';
	const userId = mailbox.reviewerId;
	const runKey = `${agent}:${run.runId}`;

	const prepared = await guarded(() =>
		db.asUser(userId, async (tx) => {
			const draft = run.draftId === null ? null : await readDraft(tx, run.draftId);
			const workKind =
				agent === 'procurement_desk' ? 'vendor_reply' : (draft?.intent ?? run.intent ?? 'other');
			const autonomy = await readAutonomy(tx, agent, workKind);
			const guardrail = nameTheGuardrail(run, draft);

			// The record, before anything is decided: which check stopped it, and
			// how big what it wrote was, so an edit can be measured later.
			if (guardrail) {
				await recordEvent(tx, {
					agent,
					runKey,
					workKind,
					kind: 'guardrail',
					checkId: guardrail.id,
					verdict: guardrail.verdict,
					detail: guardrail.reason,
					requestId: `${request}:guard:${run.runId}`
				});
			}
			if (draft) {
				await recordArtifact(tx, {
					entity: 'mail_draft',
					entityId: String(draft.id),
					runKey,
					agent,
					workKind,
					text: draft.body,
					requestId: `${request}:artifact:${draft.id}`
				});
			}
			return { draft, workKind, autonomy, guardrail };
		})
	);

	const { draft, workKind, autonomy, guardrail } = prepared;
	const plan = planRun({
		autonomy,
		guardrail: guardrail === null ? null : { checkId: guardrail.id, verdict: guardrail.verdict, reason: guardrail.reason },
		unsure: run.confidence < LOW_CONFIDENCE,
		degraded: false
	});

	const outcome: WakeOutcome = {
		runKey,
		agent,
		workKind,
		messageId: run.messageId,
		draftId: run.draftId,
		level: autonomy.level,
		plan,
		acted: false,
		actionId: null,
		undoUntil: null,
		sent: false,
		providerMessageId: null,
		simulated: false,
		sampled: false,
		guardrail: guardrail?.id ?? null,
		degraded: null,
		note: plan.why
	};

	// Why it did not act, on the record, so a quiet level is not mistaken for a
	// quiet agent.
	await guarded(() =>
		db.asUser(userId, (tx) =>
			recordEvent(tx, {
				agent,
				runKey,
				workKind,
				kind: 'autonomy',
				checkId: plan.do,
				verdict: 'noted',
				detail: plan.why,
				requestId: `${request}:plan:${run.runId}`
			})
		)
	);

	if (plan.do === 'hold' || plan.do === 'queue' || draft === null) return outcome;

	// From here it acts. Everything goes through the desk's own functions.
	const atLevel = plan.do === 'act' ? 'auto_review' : 'auto';
	try {
		const approved = await approveDraft(db, userId, {
			draftId: draft.id,
			subject: '',
			body: '',
			expectedUpdatedAt: draft.updatedAt,
			requestId: `${request}:approve:${draft.id}`
		});
		const recorded = await recordDraftAction(db, userId, {
			agent,
			workKind,
			runKey,
			draftId: draft.id,
			atLevel,
			undoMinutes: plan.do === 'act' ? plan.undoMinutes : 0,
			request
		});
		outcome.acted = true;
		outcome.actionId = recorded.actionId;
		outcome.undoUntil = recorded.undoUntil;
		outcome.sampled = recorded.sampled;
		outcome.note = `${plan.why} Approved as written (${approved.status}).`;

		// At 'auto' it goes out now. At 'auto_review' the send waits for the
		// window to close, which is what makes the undo real rather than a word.
		if (plan.do === 'act_now') {
			const send = options.send ?? sendApproved;
			const sent = await send(db, userId, draft.id, {
				client: options.client,
				allowlist: options.allowlist
			});
			outcome.sent = true;
			outcome.providerMessageId = sent.providerMessageId;
			outcome.simulated = sent.simulated;
			await recordDraftAction(db, userId, {
				agent,
				workKind,
				runKey,
				draftId: draft.id,
				atLevel: 'auto',
				undoMinutes: 0,
				action: 'send_mail',
				detail: { provider_message_id: sent.providerMessageId, simulated: sent.simulated },
				request
			});
		}
	} catch (error) {
		// Acting failed. The draft is still in the queue for a person, which is
		// the honest fallback, and the run says what went wrong.
		const reason = classifyFailure(error) ?? 'mail_provider_down';
		await guarded(() =>
			db.asUser(userId, (tx) =>
				recordDegradation(tx, {
					agent,
					runKey,
					workKind,
					reason,
					detail: error instanceof Error ? error.message : String(error),
					requestId: `${request}:degrade:${run.runId}`
				})
			)
		);
		outcome.degraded = reason;
		outcome.note = `It could not act, so a person decides: ${error instanceof Error ? error.message : String(error)}`;
	}

	return outcome;
}

/** recordAction wants a transaction; the wake works one run at a time. */
async function recordAction(db: Db, userId: number, input: ActionInput): Promise<ActionRecorded> {
	return guarded(() => db.asUser(userId, (tx) => recordActionTx(tx, input)));
}

/** The same, for the two actions the desk takes on a draft. */
async function recordDraftAction(
	db: Db,
	userId: number,
	input: {
		agent: string;
		workKind: string;
		runKey: string;
		draftId: number;
		atLevel: 'auto_review' | 'auto';
		undoMinutes: number;
		action?: string;
		detail?: Record<string, unknown>;
		request: string;
	}
): Promise<ActionRecorded> {
	const action = input.action ?? 'approve_mail_draft';
	return recordAction(db, userId, {
		agent: input.agent,
		workKind: input.workKind,
		runKey: input.runKey,
		action,
		entity: 'mail_draft',
		entityId: String(input.draftId),
		atLevel: input.atLevel,
		undoMinutes: input.undoMinutes,
		detail: input.detail ?? {},
		requestId: `${input.request}:${action}:${input.draftId}`
	});
}

/**
 * Wake one desk. Polls, works what arrived, and puts every run through the
 * ladder. One mailbox failing never stops another.
 */
export async function wakeMailbox(db: Db, mailbox: MailboxRow, options: WakeOptions): Promise<WakeSummary> {
	const request = options.requestId ?? `wake-${randomUUID()}`;
	const poll = options.poll ?? pollMailbox;
	const summary: WakeSummary = {
		mailbox: mailbox.address,
		label: mailbox.label,
		delivered: 0,
		duplicates: 0,
		outcomes: [],
		error: null,
		degraded: null
	};

	let polled: PollSummary;
	try {
		polled = await poll(db, mailbox, {
			client: options.client,
			mode: options.mode ?? 'mock',
			model: options.model ?? null,
			classify: options.classify,
			maxRuns: options.maxRuns ?? 10
		});
	} catch (error) {
		// The whole wake failed: the provider, a cap, or a database that cannot
		// be written to. Say which, and run nothing.
		const reason = classifyFailure(error) ?? 'mail_provider_down';
		summary.error = error instanceof Error ? error.message : String(error);
		summary.degraded = reason;
		return summary;
	}

	summary.delivered = polled.delivered;
	summary.duplicates = polled.duplicates;
	if (polled.error) {
		summary.error = polled.error;
		summary.degraded = classifyFailure(polled.error) ?? 'mail_provider_down';
	}

	for (const run of polled.runs) {
		summary.outcomes.push(await applyToRun(db, mailbox, run, options, request));
	}
	return summary;
}

/** Every active desk, through the harness. */
export async function wakeDesks(db: Db, options: WakeOptions): Promise<WakeSummary[]> {
	const mailboxes = await listMailboxes(db);
	const wanted = mailboxes.filter((m) => m.active && (options.only === undefined || m.id === options.only));
	const summaries: WakeSummary[] = [];
	for (const mailbox of wanted) {
		summaries.push(await wakeMailbox(db, mailbox, options));
	}
	return summaries;
}

// ---------------------------------------------------------------------------
// The window closing: what was approved alone goes out
// ---------------------------------------------------------------------------

export interface ReleaseResult {
	actionId: number;
	draftId: number;
	sent: boolean;
	simulated: boolean;
	providerMessageId: string | null;
	error: string | null;
}

/**
 * Send what an agent approved on its own once nobody undid it. This is the
 * other half of the undo window: until it runs, a person can still take the
 * approval back, and after it the mail has gone.
 */
export async function releaseDueActions(
	db: Db,
	options: { client: MailClient; allowlist: Allowlist; send?: typeof sendApproved; limit?: number }
): Promise<ReleaseResult[]> {
	const due = await db.asSystem((tx) =>
		tx.sql<{ id: number; entity_id: string; acted_by: number; agent: string; work_kind: string; run_key: string }>`
			select a.id, a.entity_id, a.acted_by, a.agent, a.work_kind, a.run_key
			from nl.agent_actions a
			join nl.mail_drafts d on d.id::text = a.entity_id
			where a.action = 'approve_mail_draft'
			  and a.at_level = 'auto_review'
			  and a.status = 'done'
			  and a.undo_until is not null
			  and a.undo_until <= now()
			  and d.status = 'approved'
			order by a.undo_until
			limit ${options.limit ?? 20}`
	);

	const results: ReleaseResult[] = [];
	for (const row of due) {
		const draftId = Number(row.entity_id);
		const send = options.send ?? sendApproved;
		try {
			const sent = await send(db, row.acted_by, draftId, {
				client: options.client,
				allowlist: options.allowlist
			});
			await recordAction(db, row.acted_by, {
				agent: row.agent,
				workKind: row.work_kind,
				runKey: row.run_key,
				action: 'send_mail',
				entity: 'mail_draft',
				entityId: String(draftId),
				atLevel: 'auto_review',
				undoMinutes: 0,
				detail: { provider_message_id: sent.providerMessageId, simulated: sent.simulated },
				requestId: `release-${row.id}-send`
			});
			results.push({
				actionId: Number(row.id),
				draftId,
				sent: true,
				simulated: sent.simulated,
				providerMessageId: sent.providerMessageId,
				error: null
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await guarded(() =>
				db.asUser(row.acted_by, (tx) =>
					recordDegradation(tx, {
						agent: row.agent,
						runKey: row.run_key,
						workKind: row.work_kind,
						reason: classifyFailure(error) ?? 'mail_provider_down',
						detail: message,
						requestId: `release-${row.id}-degrade`
					})
				)
			);
			results.push({
				actionId: Number(row.id),
				draftId,
				sent: false,
				simulated: false,
				providerMessageId: null,
				error: message
			});
		}
	}
	return results;
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

export interface UndoResult {
	actionId: number;
	status: string;
	what: string;
}

/**
 * Take back something an agent did alone. The window and who may do it are
 * checked first (nl.claim_agent_undo), the reversal goes through the feature's
 * own checked functions, and the result is recorded either way.
 *
 * A mail draft that has already gone out cannot be taken back, and says so.
 */
export async function undoAction(
	db: Db,
	userId: number,
	input: { actionId: number; reason: string; requestId: string }
): Promise<UndoResult> {
	const claim = await claimUndo(db, userId, {
		actionId: input.actionId,
		reason: input.reason,
		requestId: `${input.requestId}-claim`
	});

	try {
		if (claim.entity === 'mail_draft') {
			const draftId = Number(claim.entityId);
			const [draft] = await db.asUser(userId, (tx) =>
				tx.sql<{ status: string; updated_at: Date | string }>`
					select status, updated_at from nl.mail_drafts where id = ${draftId}`
			);
			if (!draft) throw new AppError(404, 'NL404', `Draft M-${draftId} does not exist.`);

			if (draft.status === 'sent') {
				await finishUndo(db, userId, {
					actionId: input.actionId,
					undone: false,
					irreversible: true,
					note: 'That reply has already gone out, so it cannot be taken back. Write to the customer instead.',
					requestId: `${input.requestId}-finish`
				});
				throw new AppError(
					422,
					'NL422',
					'That reply has already gone out, so it cannot be taken back. Write to the customer instead.'
				);
			}
			if (draft.status !== 'approved') {
				await finishUndo(db, userId, {
					actionId: input.actionId,
					undone: false,
					note: `The draft is ${draft.status}, so there was nothing to take back.`,
					requestId: `${input.requestId}-finish`
				});
				throw new AppError(422, 'NL422', `Draft M-${draftId} is ${draft.status}, so there is nothing to undo.`);
			}

			// Two checked functions, in the order the schema allows: an approved
			// draft becomes failed, and a failed draft can be rejected.
			const failed = await markFailed(db, userId, {
				draftId,
				error: `Undone inside the review window: ${input.reason || 'no reason given'}`,
				permanent: true,
				requestId: `${input.requestId}-fail`
			});
			await rejectDraft(db, userId, {
				draftId,
				reason: input.reason || 'Undone inside the review window.',
				expectedUpdatedAt: new Date(failed.updatedAt).toISOString(),
				requestId: `${input.requestId}-reject`
			});
			const done = await finishUndo(db, userId, {
				actionId: input.actionId,
				undone: true,
				requestId: `${input.requestId}-finish`
			});
			return { actionId: input.actionId, status: done.status, what: `Draft M-${draftId} was rejected instead.` };
		}

		if (claim.entity === 'automation_run') {
			// Every next step that run wrote, closed through the same function a
			// person uses. A note cannot be unwritten, and says so.
			const runId = Number(claim.entityId);
			const steps = await db.asUser(userId, (tx) =>
				tx.sql<{ id: number; updated_at: Date | string }>`
					select s.id, s.updated_at
					from nl.automation_firings f
					join nl.next_steps s on s.id = (f.result ->> 'id')::bigint
					where f.run_id = ${runId}
					  and f.result ->> 'kind' = 'next_step'
					  and s.completed_at is null`
			);
			for (const step of steps) {
				await db.asUser(userId, (tx) =>
					tx.sql`select nl.complete_next_step(${step.id}, ${new Date(step.updated_at).toISOString()}::timestamptz,
					                                    ${`${input.requestId}-step-${step.id}`}, 'ui')`
				);
			}
			const done = await finishUndo(db, userId, {
				actionId: input.actionId,
				undone: steps.length > 0,
				irreversible: steps.length === 0,
				note:
					steps.length > 0
						? `${steps.length} next step(s) closed.`
						: 'Nothing was left to close: a note cannot be unwritten.',
				requestId: `${input.requestId}-finish`
			});
			return {
				actionId: input.actionId,
				status: done.status,
				what: steps.length > 0 ? `${steps.length} next step(s) closed.` : 'Nothing was left to close.'
			};
		}

		await finishUndo(db, userId, {
			actionId: input.actionId,
			undone: false,
			irreversible: true,
			note: `The harness does not know how to reverse a ${claim.entity}.`,
			requestId: `${input.requestId}-finish`
		});
		throw new AppError(422, 'NL422', `The harness does not know how to reverse a ${claim.entity}.`);
	} catch (error) {
		// An AppError here has already been recorded on the action.
		const known = toAppError(error);
		if (known) throw known;
		await finishUndo(db, userId, {
			actionId: input.actionId,
			undone: false,
			note: error instanceof Error ? error.message : String(error),
			requestId: `${input.requestId}-finish`
		});
		throw error;
	}
}

// ---------------------------------------------------------------------------
// The automation runner
// ---------------------------------------------------------------------------

export interface RuleWakeResult {
	ruleId: number;
	workKind: string;
	level: Level;
	plan: Plan;
	/** What it would fire, at a level where it does not write. */
	wouldFire: number;
	fired: number;
	matched: number;
	actionId: number | null;
	undoUntil: string | null;
	error: string | null;
	note: string;
}

/**
 * Run one rule through the ladder. At shadow or suggest it is a dry run in a
 * read-only transaction and writes nothing; at auto_review or auto it fires,
 * and what it fired can be closed again inside the window.
 */
export async function wakeRule(
	db: Db,
	userId: number,
	ruleId: number,
	options: { via: 'ui' | 'schedule'; requestId?: string }
): Promise<RuleWakeResult> {
	const request = options.requestId ?? `rule-wake-${randomUUID()}`;

	const [rule] = await db.asUser(userId, (tx) =>
		tx.sql<{ id: number; name: string; action: { kind: string }; owner_id: number; enabled: boolean }>`
			select id, name, action, owner_id, enabled from nl.automation_rules where id = ${ruleId}`
	);
	if (!rule) throw new AppError(404, 'NL404', `Rule ${ruleId} does not exist.`);

	const workKind = rule.action?.kind === 'note' ? 'note' : 'next_step';
	const autonomy = await db.asUser(userId, (tx) => readAutonomy(tx, 'automation', workKind));
	const plan = planRun({ autonomy });

	const result: RuleWakeResult = {
		ruleId,
		workKind,
		level: autonomy.level,
		plan,
		wouldFire: 0,
		fired: 0,
		matched: 0,
		actionId: null,
		undoUntil: null,
		error: null,
		note: plan.why
	};

	if (plan.do === 'hold' || plan.do === 'queue') {
		// A dry run: testRule sets the transaction read only, so the database
		// itself refuses any write this makes.
		const test = await testRule(db, userId, await ruleForTest(db, userId, ruleId), ruleId);
		result.matched = test.total;
		result.wouldFire = test.total - test.alreadyFired;
		await guarded(() =>
			db.asUser(userId, (tx) =>
				recordEvent(tx, {
					agent: 'automation',
					runKey: `automation:${ruleId}`,
					workKind,
					kind: 'autonomy',
					checkId: plan.do,
					verdict: 'noted',
					detail: `${plan.why} It would have fired for ${result.wouldFire} subject(s).`,
					requestId: `${request}:plan`
				})
			)
		);
		return result;
	}

	let run: RuleRunResult;
	try {
		run = await runRule(db, userId, ruleId, options.via);
	} catch (error) {
		const reason = classifyFailure(error);
		result.error = error instanceof Error ? error.message : String(error);
		if (reason) {
			await guarded(() =>
				db.asUser(userId, (tx) =>
					recordDegradation(tx, {
						agent: 'automation',
						runKey: `automation:${ruleId}`,
						workKind,
						reason,
						detail: result.error ?? '',
						requestId: `${request}:degrade`
					})
				)
			);
		}
		return result;
	}

	result.matched = run.matched;
	result.fired = run.fired;
	result.error = run.error;

	if (run.fired > 0) {
		const recorded = await recordAction(db, userId, {
			agent: 'automation',
			workKind,
			runKey: `automation:${run.runId}`,
			action: 'fire_automation',
			entity: 'automation_run',
			entityId: String(run.runId),
			atLevel: plan.do === 'act' ? 'auto_review' : 'auto',
			undoMinutes: plan.do === 'act' ? plan.undoMinutes : 0,
			detail: { rule_id: ruleId, fired: run.fired, matched: run.matched },
			requestId: `${request}:fire:${run.runId}`
		});
		result.actionId = recorded.actionId;
		result.undoUntil = recorded.undoUntil;
	}
	result.note = `${plan.why} ${run.fired} of ${run.matched} fired.`;
	return result;
}

/** The saved rule in the shape testRule wants. */
async function ruleForTest(db: Db, userId: number, ruleId: number) {
	const [row] = await db.asUser(userId, (tx) =>
		tx.sql<{
			name: string;
			description: string;
			trigger: string;
			conditions: unknown;
			action: unknown;
			enabled: boolean;
		}>`
			select name, description, trigger, conditions, action, enabled
			from nl.automation_rules where id = ${ruleId}`
	);
	return {
		name: row.name,
		description: row.description,
		trigger: row.trigger,
		conditions: row.conditions,
		action: row.action,
		enabled: row.enabled
	};
}

export type { Autonomy, GuardrailInput };
export { firstFailure };
