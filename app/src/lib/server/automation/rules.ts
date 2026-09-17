// Automation rules: list, read, save, try out, and run.
//
// A rule is stored as data (nl.automation_rules). To run it, compile.ts turns
// it into one parameterized query over its trigger's reviewed source, and
// nl.fire_automation writes the action once per subject. Every database call
// runs as a signed-in person, so row-level security and the write functions'
// own checks apply to automations exactly as they do to people.
import { z } from 'zod';
import { ruleSchema, TRIGGERS, type Rule, type TriggerKey } from '$lib/automation/catalog';
import { describeRule, renderTemplate } from '$lib/automation/describe';
import type {
	FiringItem,
	PersonOption,
	RuleDetail,
	RuleListItem,
	RunResult,
	RunSummary,
	TestMatch,
	TestResult
} from '$lib/automation/types';
import type { Db, Tx } from '../db/types.ts';
import { AppError, guarded, toAppError } from '../errors.ts';
import { compileRule, refuseRule, type MatchRow } from './compile.ts';

/** A run writes at most this many subjects; the rest wait for the next run. */
export const RUN_CAP = 200;
/** A dry run shows this many matches. */
export const TEST_ROWS = 25;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

interface RuleRow {
	id: number;
	name: string;
	description: string;
	trigger: TriggerKey;
	conditions: Rule['conditions'];
	action: Rule['action'];
	enabled: boolean;
	owner_id: number;
	owner_name: string;
	updated_at: Date;
	firing_count: number;
	is_admin: boolean;
}

interface RunRow {
	id: number;
	via: 'ui' | 'schedule';
	run_by_name: string;
	started_at: Date;
	finished_at: Date | null;
	matched: number | null;
	fired: number | null;
	skipped: number | null;
	error: string | null;
}

function toRun(row: RunRow): RunSummary {
	return {
		id: row.id,
		via: row.via,
		runBy: row.run_by_name,
		startedAt: row.started_at.toISOString(),
		finishedAt: row.finished_at?.toISOString() ?? null,
		matched: row.matched,
		fired: row.fired,
		skipped: row.skipped,
		error: row.error
	};
}

function toRule(row: RuleRow): Rule {
	return {
		name: row.name,
		description: row.description,
		trigger: row.trigger,
		conditions: row.conditions,
		action: row.action,
		enabled: row.enabled
	};
}

/** Everyone's names, for sentences like "owner is Dana Whitlock". */
async function nameLookup(tx: Tx): Promise<(id: number) => string> {
	const people = await tx.sql<{ id: number; full_name: string }>`select id, full_name from nl.users`;
	const names = new Map(people.map((p) => [p.id, p.full_name]));
	return (id) => names.get(id) ?? `user ${id}`;
}

/** Active people, for the editor's person picker. */
export async function listPeople(db: Db, userId: number): Promise<PersonOption[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.sql<{ id: number; full_name: string }>`
			select id, full_name from nl.users where active order by full_name`
	);
	return rows.map((r) => ({ id: r.id, name: r.full_name }));
}

// The columns both the list and the editor read.
const RULE_COLUMNS = `
	r.id, r.name, r.description, r.trigger, r.conditions, r.action, r.enabled,
	r.owner_id, u.full_name as owner_name, r.updated_at,
	(select count(*) from nl.automation_firings f where f.rule_id = r.id)::int as firing_count,
	nl.is_admin() as is_admin`;

export async function listRules(db: Db, userId: number): Promise<RuleListItem[]> {
	return db.asUser(userId, async (tx) => {
		const rows = await tx.query<RuleRow & Partial<RunRow> & { run_id: number | null }>(`
			select ${RULE_COLUMNS},
			       lr.id as run_id, lr.via, lr.run_by_name, lr.started_at, lr.finished_at,
			       lr.matched, lr.fired, lr.skipped, lr.error
			from nl.automation_rules r
			join nl.users u on u.id = r.owner_id
			-- The latest run of each rule, if it has one.
			left join lateral (
			  select x.id, x.via, ru.full_name as run_by_name, x.started_at, x.finished_at,
			         x.matched, x.fired, x.skipped, x.error
			  from nl.automation_runs x
			  join nl.users ru on ru.id = x.run_by
			  where x.rule_id = r.id
			  order by x.started_at desc, x.id desc
			  limit 1
			) lr on true
			order by r.enabled desc, lower(r.name), r.id`);
		const nameOf = await nameLookup(tx);

		return rows.map((row) => ({
			id: row.id,
			name: row.name,
			description: row.description,
			trigger: row.trigger,
			triggerLabel: TRIGGERS[row.trigger].label,
			sentence: describeRule(row, nameOf, row.owner_name),
			enabled: row.enabled,
			ownerId: row.owner_id,
			ownerName: row.owner_name,
			canEdit: row.owner_id === userId || row.is_admin,
			lastRun:
				row.run_id === null
					? null
					: toRun({
							id: row.run_id,
							via: row.via!,
							run_by_name: row.run_by_name!,
							started_at: row.started_at!,
							finished_at: row.finished_at ?? null,
							matched: row.matched ?? null,
							fired: row.fired ?? null,
							skipped: row.skipped ?? null,
							error: row.error ?? null
						}),
			firingCount: row.firing_count
		}));
	});
}

export async function getRule(db: Db, userId: number, id: number): Promise<RuleDetail | null> {
	return db.asUser(userId, async (tx) => {
		const [row] = await tx.query<RuleRow>(
			`select ${RULE_COLUMNS}
			 from nl.automation_rules r
			 join nl.users u on u.id = r.owner_id
			 where r.id = $1`,
			[id]
		);
		if (!row) return null;

		const runs = await tx.sql<RunRow>`
			select x.id, x.via, ru.full_name as run_by_name, x.started_at, x.finished_at,
			       x.matched, x.fired, x.skipped, x.error
			from nl.automation_runs x
			join nl.users ru on ru.id = x.run_by
			where x.rule_id = ${id}
			order by x.started_at desc, x.id desc
			limit 10`;

		// A firing's result says what it made: {"kind": "next_step", "id": 42}.
		const firings = await tx.sql<{
			id: number;
			subject_key: string;
			fired_at: Date;
			run_id: number;
			kind: 'next_step' | 'note' | null;
			text: string | null;
			customer_no: string | null;
			customer_name: string | null;
			commitment_id: number | null;
			assignee_name: string | null;
			due_on: string | null;
		}>`
			select f.id, f.subject_key, f.fired_at, f.run_id, f.result ->> 'kind' as kind,
			       coalesce(ns.title, a.body) as text,
			       coalesce(ns.customer_no, a.customer_no) as customer_no,
			       cu.name as customer_name,
			       coalesce(ns.commitment_id, a.commitment_id) as commitment_id,
			       au.full_name as assignee_name,
			       ns.due_on
			from nl.automation_firings f
			left join nl.next_steps ns
			  on f.result ->> 'kind' = 'next_step' and ns.id = (f.result ->> 'id')::bigint
			left join nl.activities a
			  on f.result ->> 'kind' = 'note' and a.id = (f.result ->> 'id')::bigint
			left join nl.customers cu on cu.customer_no = coalesce(ns.customer_no, a.customer_no)
			left join nl.users au on au.id = ns.owner_id
			where f.rule_id = ${id}
			order by f.fired_at desc, f.id desc
			limit 25`;

		return {
			id: row.id,
			rule: toRule(row),
			ownerId: row.owner_id,
			ownerName: row.owner_name,
			// ISO text keeps the millisecond the database stored; it goes back as the row version.
			updatedAt: row.updated_at.toISOString(),
			canEdit: row.owner_id === userId || row.is_admin,
			firingCount: row.firing_count,
			runs: runs.map(toRun),
			firings: firings.map(
				(f): FiringItem => ({
					id: f.id,
					subjectKey: f.subject_key,
					firedAt: f.fired_at.toISOString(),
					runId: f.run_id,
					kind: f.kind,
					text: f.text,
					customerNo: f.customer_no,
					customerName: f.customer_name,
					commitmentId: f.commitment_id,
					assigneeName: f.assignee_name,
					dueOn: f.due_on
				})
			)
		};
	});
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

export const saveRuleInput = z
	.object({
		ruleId: z.number().int().positive().nullable(),
		rule: ruleSchema,
		expectedUpdatedAt: z.iso.datetime({ offset: true }).nullable(),
		requestId: z.string().min(8).max(100)
	})
	.refine((input) => input.ruleId === null || input.expectedUpdatedAt !== null, {
		path: ['expectedUpdatedAt'],
		message: 'Changing a saved rule needs the version that was loaded.'
	});

export interface SaveResult {
	ruleId: number;
	updatedAt: string;
	replayed: boolean;
}

export async function saveRule(db: Db, userId: number, input: unknown): Promise<SaveResult> {
	const parsed = saveRuleInput.safeParse(input);
	if (!parsed.success) refuseRule(parsed.error.issues);
	const { ruleId, rule, expectedUpdatedAt, requestId } = parsed.data;

	const [row] = await guarded(() =>
		db.asUser(userId, (tx) =>
			tx.sql<{ result: { rule_id: number; updated_at: string; replayed?: boolean } }>`
				select nl.save_automation_rule(
				  ${ruleId}::bigint, ${rule.name}, ${rule.description}, ${rule.trigger},
				  ${JSON.stringify(rule.conditions)}::jsonb, ${JSON.stringify(rule.action)}::jsonb,
				  ${rule.enabled}, ${expectedUpdatedAt}::timestamptz, ${requestId}
				) as result`
		)
	);
	return {
		ruleId: row.result.rule_id,
		// Postgres writes JSON timestamps its own way; normalize to the ISO form pages send back.
		updatedAt: new Date(row.result.updated_at).toISOString(),
		replayed: row.result.replayed === true
	};
}

// ---------------------------------------------------------------------------
// Matching: shared by the dry run and the real run
// ---------------------------------------------------------------------------

/** The person a match's next step goes to. */
function assigneeFor(rule: Rule, row: MatchRow, ruleOwnerId: number, active: ReadonlyMap<number, string>): number {
	// The record's owner when the rule says so and that person can still take
	// it; otherwise the rule's owner. Accounts can have no owner, and an owner
	// can have left the company.
	if (
		rule.action.kind === 'next_step' &&
		rule.action.assignTo === 'record_owner' &&
		row.record_owner_id !== null &&
		active.has(row.record_owner_id)
	) {
		return row.record_owner_id;
	}
	return ruleOwnerId;
}

/** The text the action writes for one match, within the database's 500 characters. */
function textFor(rule: Rule, row: MatchRow): string {
	const template = rule.action.kind === 'next_step' ? rule.action.title : rule.action.body;
	const text = renderTemplate(rule.trigger, template, row);
	return (text || row.headline).slice(0, 500);
}

async function activePeople(tx: Tx): Promise<Map<number, string>> {
	const rows = await tx.sql<{ id: number; full_name: string }>`
		select id, full_name from nl.users where active`;
	return new Map(rows.map((r) => [r.id, r.full_name]));
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

/**
 * What a rule would do right now, without doing any of it. The transaction
 * is read only, so the database itself refuses any write. With a ruleId,
 * "me" means that rule's owner and matches it already fired for are marked.
 */
export async function testRule(
	db: Db,
	userId: number,
	rule: unknown,
	ruleId: number | null = null
): Promise<TestResult> {
	return guarded(() =>
		db.asUser(userId, async (tx) => {
			await tx.sql`set transaction read only`;

			let ownerId = userId;
			if (ruleId !== null) {
				const [saved] = await tx.sql<{ owner_id: number }>`
					select owner_id from nl.automation_rules where id = ${ruleId}`;
				if (!saved) throw new AppError(404, 'NL404', `Rule ${ruleId} does not exist.`);
				ownerId = saved.owner_id;
			}

			const compiled = compileRule(rule, { ownerId, ruleId, limit: TEST_ROWS });
			const rows = await tx.query<MatchRow>(compiled.text, compiled.params);
			const active = await activePeople(tx);
			const valid = compiled.rule;
			const trigger = TRIGGERS[valid.trigger];

			// Columns: the fields the conditions use, then the trigger's first
			// fields, three at most. People are shown elsewhere.
			const numeric = trigger.fields.filter((f) => f.type !== 'user').map((f) => f.key);
			const used = valid.conditions.map((c) => c.field).filter((key) => numeric.includes(key));
			const fields = [...new Set([...used, ...numeric])].slice(0, 3);

			const matches = rows.map((row): TestMatch => {
				const values: Record<string, number | null> = {};
				for (const key of fields) {
					const value = row[key];
					values[key] = typeof value === 'number' ? value : null;
				}
				const assignee = valid.action.kind === 'next_step' ? assigneeFor(valid, row, ownerId, active) : null;
				return {
					subjectKey: row.subject_key,
					customerNo: row.customer_no,
					customerName: row.customer_name,
					commitmentId: row.commitment_id,
					headline: row.headline,
					values,
					text: textFor(valid, row),
					assigneeName: assignee === null ? null : (active.get(assignee) ?? null),
					alreadyFired: row.already_fired
				};
			});

			return {
				total: rows[0]?.total_matches ?? 0,
				alreadyFired: rows[0]?.fired_before ?? 0,
				fields,
				matches
			};
		})
	);
}

// ---------------------------------------------------------------------------
// Real runs
// ---------------------------------------------------------------------------

function messageOf(error: unknown): string {
	const known = toAppError(error);
	if (known) return known.message;
	return error instanceof Error ? error.message : String(error);
}

/**
 * Run a saved rule once, as userId (its owner or an admin).
 *
 * Three transactions:
 *   1. start the run (refused here if the person may not run it), so the
 *      run is on record whatever happens next;
 *   2. find the matches and fire for each one, all or nothing;
 *   3. finish the run with its counts, or with the error that stopped it.
 *
 * A refusal in step 1 is thrown (403, 404, 422). A failure in step 2 is
 * recorded on the run and returned in `error`.
 */
export async function runRule(
	db: Db,
	userId: number,
	ruleId: number,
	via: 'ui' | 'schedule'
): Promise<RunResult> {
	const started = await guarded(() =>
		db.asUser(userId, async (tx) => {
			const [run] = await tx.sql<{ id: number }>`select nl.start_automation_run(${ruleId}, ${via}) as id`;
			const [rule] = await tx.sql<RuleRow>`
				select r.id, r.name, r.description, r.trigger, r.conditions, r.action, r.enabled, r.owner_id
				from nl.automation_rules r where r.id = ${ruleId}`;
			return { runId: run.id, rule };
		})
	);
	const { runId, rule } = started;

	let matched = 0;
	let fired = 0;
	let skipped = 0;
	let error: string | null = null;

	try {
		await db.asUser(userId, async (tx) => {
			// Not yet fired first, so subjects past the cap get their turn on a later run.
			const compiled = compileRule(toRule(rule), {
				ownerId: rule.owner_id,
				ruleId,
				limit: RUN_CAP,
				unfiredFirst: true
			});
			const rows = await tx.query<MatchRow>(compiled.text, compiled.params);
			const active = await activePeople(tx);
			const valid = compiled.rule;
			const dueInDays = valid.action.kind === 'next_step' ? valid.action.dueInDays : null;

			matched = rows[0]?.total_matches ?? 0;
			skipped = rows[0]?.fired_before ?? 0;

			for (const row of rows) {
				if (row.already_fired) continue; // counted in fired_before
				// The database takes the action's kind from the stored rule; the
				// assignee and due date only matter to a next step.
				const [result] = await tx.sql<{ outcome: 'fired' | 'skipped' }>`
					select nl.fire_automation(
					  ${runId}, ${row.subject_key}, ${row.customer_no}, ${row.commitment_id}::bigint,
					  ${assigneeFor(valid, row, rule.owner_id, active)}::int, ${textFor(valid, row)},
					  (select nl.today()) + ${dueInDays}::int
					) as outcome`;
				// 'skipped' here means another run fired for it a moment ago.
				if (result.outcome === 'fired') fired += 1;
				else skipped += 1;
			}
		});
	} catch (failure) {
		// Step 2 rolled back, so nothing it wrote stays.
		error = messageOf(failure);
		fired = 0;
	}

	await guarded(() =>
		db.asUser(userId, (tx) =>
			tx.sql`select nl.finish_automation_run(${runId}, ${matched}, ${fired}, ${skipped}, ${error})`
		)
	);
	return { runId, matched, fired, skipped, error };
}

export interface ScheduledRuleResult {
	ruleId: number;
	name: string;
	ownerId: number;
	runId: number | null;
	matched: number;
	fired: number;
	skipped: number;
	error: string | null;
}

export interface ScheduleSummary {
	startedAt: string;
	rules: number;
	fired: number;
	failed: number;
	results: ScheduledRuleResult[];
}

/**
 * The daily job: run every switched-on rule as its owner. One rule failing,
 * or belonging to someone who has left, never stops the others.
 */
export async function runScheduled(db: Db): Promise<ScheduleSummary> {
	const startedAt = new Date().toISOString();
	const rules = await db.asSystem((tx) =>
		tx.sql<{ id: number; name: string; owner_id: number; owner_active: boolean; owner_name: string }>`
			select r.id, r.name, r.owner_id, u.active as owner_active, u.full_name as owner_name
			from nl.automation_rules r
			join nl.users u on u.id = r.owner_id
			where r.enabled
			order by r.id`
	);

	const results: ScheduledRuleResult[] = [];
	for (const rule of rules) {
		const base = { ruleId: rule.id, name: rule.name, ownerId: rule.owner_id };
		if (!rule.owner_active) {
			// Nobody can run as a person who has left, so the job writes the
			// failed run itself. The rule waits for an admin to take it over.
			const error = `${rule.owner_name} is no longer active, so this rule did not run. An admin can take it over.`;
			const [run] = await db.asSystem((tx) =>
				tx.sql<{ id: number }>`
					insert into nl.automation_runs (rule_id, run_by, via, finished_at, matched, fired, skipped, error)
					values (${rule.id}, ${rule.owner_id}, 'schedule', now(), 0, 0, 0, ${error})
					returning id`
			);
			results.push({ ...base, runId: run.id, matched: 0, fired: 0, skipped: 0, error });
			continue;
		}
		try {
			const run = await runRule(db, rule.owner_id, rule.id, 'schedule');
			results.push({ ...base, ...run });
		} catch (failure) {
			results.push({ ...base, runId: null, matched: 0, fired: 0, skipped: 0, error: messageOf(failure) });
		}
	}

	return {
		startedAt,
		rules: results.length,
		fired: results.reduce((sum, r) => sum + r.fired, 0),
		failed: results.filter((r) => r.error !== null).length,
		results
	};
}
