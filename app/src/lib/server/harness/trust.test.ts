// The /agents trust page, against a real database.
//
// The page makes five claims and this file holds it to each of them:
//
//   1. every figure on it equals a direct query of the same thing, so there
//      is never a second number for one fact;
//   2. an agent with no runs reads as "nothing yet" and not as a zero that
//      looks like a failure;
//   3. raising an agent's autonomy is refused without the authority to change
//      a policy, and audited when it goes through, in the same table and with
//      the same call as raising a person's approval limit;
//   4. a paused agent says so, anybody may pull the brake, and only an admin
//      may let it go;
//   5. the eval summary is the eval runner's own figures and not a second
//      count of the case files.
//
// The world is the small test world with today pinned to 2026-09-17. Nothing
// here calls a model, sends mail or reaches the network.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDb } from '../db/pglite.ts';
import type { Db } from '../db/types.ts';
import { readBaseline, loadJsonCases, loadTextCases } from './evals/shared.ts';
import { readBoard, setPause } from './ladder.ts';
import {
	grantToLevel,
	levelToGrant,
	mayPromote,
	principalFor,
	setGrantedAutonomy
} from './promotion.ts';
import { AGENTS } from './scope.ts';
import {
	caseFolder,
	guardrailRoster,
	ratesFor,
	readAgentTrust,
	readEvalSummary,
	readRefusals,
	readTrustTrend
} from './trust.ts';
import { LEVELS, LEVEL_LABEL, LEVEL_ORDER } from './types.ts';

const TODAY = '2026-09-17';
const ADMIN = 1;
/** An account manager: not an admin, and does not hold change_policy. */
const DANA = 2;
/** The chief executive, who holds change_policy in db/seed.d/90_roles.sql. */
const POLICY_HOLDER = 16;

let db: Db;

beforeAll(async () => {
	db = await createTestDb({ today: TODAY });
}, 240_000);

afterAll(async () => {
	await db?.close();
});

/** The same counts, straight out of the view, with nothing in between. */
async function countsDirect(agent: string) {
	const [row] = await db.asUser(ADMIN, (tx) =>
		tx.sql<{
			runs: number;
			waiting: number;
			reviewed: number;
			approved: number;
			edited: number;
			rejected: number;
			refusals: number;
		}>`
			select count(*)::int                                                    as runs,
			       count(*) filter (where review_state = 'waiting')::int            as waiting,
			       count(*) filter (where review_state in
			         ('approved', 'edited_approved', 'rejected'))::int              as reviewed,
			       count(*) filter (where review_state = 'approved')::int           as approved,
			       count(*) filter (where review_state = 'edited_approved')::int    as edited,
			       count(*) filter (where review_state = 'rejected')::int           as rejected,
			       count(*) filter (where guardrail is not null)::int               as refusals
			from nl.agent_run_log
			where agent = ${agent}`
	);
	return row;
}

describe('every figure on the page equals a direct query of the same thing', () => {
	it('matches nl.agent_run_log, agent by agent', async () => {
		const rows = await readAgentTrust(db, ADMIN);
		expect(rows.map((r) => r.agent)).toEqual([...AGENTS]);

		for (const row of rows) {
			const direct = await countsDirect(row.agent);
			// Named one at a time rather than with a single object compare, so a
			// failure says WHICH figure drifted.
			expect(row.runs, `${row.agent} runs`).toBe(direct.runs);
			expect(row.waiting, `${row.agent} waiting`).toBe(direct.waiting);
			expect(row.reviewed, `${row.agent} reviewed`).toBe(direct.reviewed);
			expect(row.approved, `${row.agent} approved`).toBe(direct.approved);
			expect(row.edited, `${row.agent} edited`).toBe(direct.edited);
			expect(row.rejected, `${row.agent} rejected`).toBe(direct.rejected);
			expect(row.refusals, `${row.agent} refusals`).toBe(direct.refusals);
		}
	});

	it('matches the autonomy board summed, which is the harness own per-kind figure', async () => {
		const rows = await readAgentTrust(db, ADMIN);
		const board = await readBoard(db, ADMIN);

		for (const row of rows) {
			const mine = board.filter((b) => b.agent === row.agent);
			const sum = (pick: (b: (typeof mine)[number]) => number) =>
				mine.reduce((total, b) => total + pick(b), 0);
			expect(row.runs, `${row.agent} runs vs the board`).toBe(sum((b) => b.runs));
			expect(row.reviewed, `${row.agent} reviewed vs the board`).toBe(sum((b) => b.reviewed));
			expect(row.approved, `${row.agent} approved vs the board`).toBe(sum((b) => b.approved));
			expect(row.edited, `${row.agent} edited vs the board`).toBe(sum((b) => b.edited));
			expect(row.rejected, `${row.agent} rejected vs the board`).toBe(sum((b) => b.rejected));
			expect(row.refusals, `${row.agent} refusals vs the board`).toBe(sum((b) => b.refusals));
		}
	});

	it('computes the two rates the way nl.agent_metrics does', () => {
		// Of the runs somebody decided, the share let through either way.
		expect(ratesFor({ approved: 8, edited: 1, rejected: 1 }).approvalRate).toBe(0.9);
		// Of the ones let through, the share a person had to change first.
		expect(ratesFor({ approved: 8, edited: 2, rejected: 0 }).editRate).toBe(0.2);
		// Nothing to divide by is null, never zero.
		expect(ratesFor({ approved: 0, edited: 0, rejected: 0 }).approvalRate).toBeNull();
		expect(ratesFor({ approved: 0, edited: 0, rejected: 3 }).editRate).toBeNull();
	});

	/*
	  The regression this file exists for.

	  The first version of the roll-up joined nl.agent_actions with a plain
	  left join. A run can take more than one action, so a run with two
	  actions came back as two rows, count(*) said 2 runs, and every rate on
	  the page was computed over doubled figures while nl.agent_metrics said
	  something else. This gives one run two actions and checks the count does
	  not move.
	*/
	it('does not count a run twice when it took two actions', async () => {
		// A real run, made by inserting a mail run against a message the world
		// already has. The desk itself is not woken: this test is about the
		// arithmetic, and waking it would drag in the mail provider.
		const [message] = await db.asUser(ADMIN, (tx) =>
			tx.sql<{ id: number; mailbox_id: number }>`
				select m.id, m.mailbox_id
				from nl.mail_messages m
				join nl.mailboxes b on b.id = m.mailbox_id
				where b.kind = 'orders'
				order by m.id
				limit 1`
		);
		expect(message, 'the test world seeds an order desk inbox').toBeTruthy();

		const [run] = await db.asSystem((tx) =>
			tx.sql<{ id: number }>`
				insert into nl.mail_runs (mailbox_id, message_id, mode, outcome, finished_at)
				values (${message.mailbox_id}, ${message.id}, 'mock', 'drafted', now())
				returning id`
		);
		const runKey = `order_desk:${run.id}`;

		const before = await readAgentTrust(db, ADMIN);
		const oneRun = before.find((r) => r.agent === 'order_desk')!;
		const direct = await countsDirect('order_desk');
		expect(oneRun.runs).toBe(direct.runs);

		// Two actions on the one run. The unique key is (run_key, action,
		// request_id), so they differ by action.
		for (const action of ['queue_mail_draft', 'add_next_step']) {
			await db.asSystem((tx) =>
				tx.sql`
					insert into nl.agent_actions
						(agent, work_kind, run_key, action, entity, entity_id, at_level,
						 acted_by, request_id)
					values ('order_desk', 'price_question', ${runKey}, ${action},
					        'mail_draft', ${String(run.id)}, 'auto_review',
					        ${ADMIN}, ${`trust-test-${action}-${randomUUID()}`})`
			);
		}

		const after = await readAgentTrust(db, ADMIN);
		const sameRun = after.find((r) => r.agent === 'order_desk')!;
		expect(sameRun.runs, 'two actions must not make two runs').toBe(oneRun.runs);
		expect(sameRun.reviewed).toBe(oneRun.reviewed);
		// The actions themselves are still both counted, because that figure is
		// about actions and not about runs.
		expect(sameRun.actedAlone).toBe(oneRun.actedAlone + 2);
	});

	it('adds the weekly trend up to the agent own figure', async () => {
		const rows = await readAgentTrust(db, ADMIN);
		for (const row of rows) {
			const trend = await readTrustTrend(db, ADMIN, { agent: row.agent, weeks: 52 });
			const runs = trend.weeks.reduce((sum, w) => sum + w.runs, 0);
			const refusals = trend.weeks.reduce((sum, w) => sum + w.refusals, 0);
			// A run older than the window is outside the trend, so the weeks can
			// only ever be a subset. They must never exceed the whole.
			expect(runs, `${row.agent} trend runs`).toBeLessThanOrEqual(row.runs);
			expect(refusals, `${row.agent} trend refusals`).toBeLessThanOrEqual(row.refusals);
		}
	});

	it('draws the promotion threshold from the strictest rule that applies', async () => {
		const trend = await readTrustTrend(db, ADMIN, { agent: 'order_desk', weeks: 8 });
		const board = await readBoard(db, ADMIN);
		const floors = board
			.filter((b) => b.agent === 'order_desk')
			.map((b) => b.rule?.minApprovalRate)
			.filter((r): r is number => typeof r === 'number');

		if (floors.length === 0) {
			expect(trend.threshold).toBeNull();
		} else {
			// The strictest, not the easiest: clearing the easiest rule is not
			// the claim a reference line should make.
			expect(trend.threshold).toBe(Math.max(...floors));
			expect(trend.thresholdWords).toContain('%');
		}
	});
});

describe('an agent with no runs reads as nothing yet', () => {
	it('gives a null rate rather than a zero', async () => {
		const rows = await readAgentTrust(db, ADMIN);
		const quiet = rows.filter((r) => r.runs === 0);

		// A fresh world has no agent runs at all, so this is not a vacuous
		// filter. If that ever changes the assertion below says so out loud.
		expect(quiet.length, 'some agent has not run in a fresh world').toBeGreaterThan(0);

		for (const row of quiet) {
			expect(row.approvalRate, `${row.agent} approval rate`).toBeNull();
			expect(row.editRate, `${row.agent} edit rate`).toBeNull();
			expect(row.lastRunAt, `${row.agent} last run`).toBeNull();
			// A zero would read as total failure. Null is what the page turns
			// into the words "nothing yet".
			expect(row.approvalRate).not.toBe(0);
		}
	});

	it('still names every agent and every kind of work it does', async () => {
		const rows = await readAgentTrust(db, ADMIN);
		for (const row of rows) {
			expect(row.name.length, `${row.agent} has a name`).toBeGreaterThan(2);
			expect(row.purpose.length, `${row.agent} says what it is for`).toBeGreaterThan(10);
			// Every agent in the written scope has its kinds of work on the
			// board, whether or not it has ever run one.
			expect(row.kinds.length, `${row.agent} kinds of work`).toBeGreaterThan(0);
			expect(row.levels.length, `${row.agent} levels`).toBeGreaterThan(0);
		}
	});
});

describe('raising autonomy is the same audited write as raising a person limit', () => {
	it('is refused without the authority to change a policy', async () => {
		expect(await mayPromote(db, DANA)).toBe(false);
		await expect(
			setGrantedAutonomy(db, DANA, {
				agent: 'order_desk',
				level: 2,
				startsOn: null,
				note: 'should not go through',
				requestId: `trust-refuse-${randomUUID()}`
			})
		).rejects.toMatchObject({ status: 403 });
	});

	it('goes through for the policy holder, into nl.authority_grants, with an audit row', async () => {
		expect(await mayPromote(db, POLICY_HOLDER)).toBe(true);

		const requestId = `trust-grant-${randomUUID()}`;
		const result = await setGrantedAutonomy(db, POLICY_HOLDER, {
			agent: 'order_desk',
			level: 2,
			startsOn: null,
			note: 'Two hundred replies reviewed and none refused.',
			requestId
		});
		expect(result.authority).toBe('agent_autonomy');
		expect(Number(result.limit)).toBe(2);

		const principal = await principalFor(db, ADMIN, 'order_desk');

		// The grant is a row in the table a person's approval ceiling lives in.
		// That is the claim the whole roles model rests on, so it is asserted
		// against the table and not against the page.
		const [grant] = await db.asUser(ADMIN, (tx) =>
			tx.sql<{ limit_amount: string | number | null; note: string; granted_by: number }>`
				select limit_amount, note, granted_by
				from nl.authority_grants
				where user_id = ${principal} and authority = 'agent_autonomy'
				  and starts_on <= nl.today()
				  and (ends_on is null or ends_on >= nl.today())
				order by starts_on desc
				limit 1`
		);
		expect(Number(grant.limit_amount)).toBe(2);
		expect(grant.granted_by).toBe(POLICY_HOLDER);

		// And it is audited, by the database, with the actor and the request id.
		const [audit] = await db.asUser(ADMIN, (tx) =>
			tx.sql<{ actor_id: number; action: string; entity_id: string }>`
				select actor_id, action, entity_id
				from nl.audit_log
				where request_id = ${requestId} and action = 'grant_authority'`
		);
		expect(audit, 'the grant leaves an audit row').toBeTruthy();
		expect(audit.actor_id).toBe(POLICY_HOLDER);
		expect(audit.entity_id).toBe(String(principal));

		// The page reads it back as the granted level.
		const rows = await readAgentTrust(db, POLICY_HOLDER);
		const desk = rows.find((r) => r.agent === 'order_desk')!;
		expect(desk.granted?.level).toBe(2);
		expect(desk.granted?.principalId).toBe(principal);
	});

	it('refuses a level off the ladder, in the database and not on the page', async () => {
		await expect(
			setGrantedAutonomy(db, POLICY_HOLDER, {
				agent: 'order_desk',
				// The zod input caps this at 3 on the page. This calls the
				// function directly, which is how the DATABASE check gets
				// exercised rather than only the form's.
				level: 9,
				startsOn: null,
				note: '',
				requestId: `trust-toohigh-${randomUUID()}`
			})
		).rejects.toMatchObject({ status: 422 });
	});

	it('has no principal for the three agents that are not desks', async () => {
		const rows = await readAgentTrust(db, ADMIN);
		for (const agent of ['assistant', 'automation', 'mcp']) {
			const row = rows.find((r) => r.agent === agent)!;
			// Not a bug and not hidden: only the two desks are principals in
			// nl.users, so only they have a grant to raise. The page says so.
			expect(row.granted, `${agent} is not a principal`).toBeNull();
		}
		await expect(principalFor(db, ADMIN, 'assistant')).rejects.toThrow(/not a principal/);
	});

	it('converts between the harness level name and the grant number, both ways', () => {
		for (const level of LEVELS) {
			expect(levelToGrant(level)).toBe(LEVEL_ORDER[level] - 1);
			expect(grantToLevel(levelToGrant(level))).toBe(level);
		}
		expect(grantToLevel(null)).toBeNull();
		// Every level has words to go with it, so the page never shows a bare
		// number where a person has to remember what 2 means.
		for (const level of LEVELS) expect(LEVEL_LABEL[level].length).toBeGreaterThan(3);
	});
});

describe('a paused agent says so', () => {
	it('shows the pause, who pulled it and why, and only an admin lets it go', async () => {
		const reason = 'Checking a reply that read badly.';
		// Anybody active may pull the brake. That asymmetry is deliberate:
		// hitting the brake should never need a permission.
		await setPause(db, DANA, {
			agent: 'order_desk',
			paused: true,
			reason,
			requestId: `trust-pause-${randomUUID()}`
		});

		const paused = await readAgentTrust(db, ADMIN);
		const desk = paused.find((r) => r.agent === 'order_desk')!;
		expect(desk.paused).toBe(true);
		expect(desk.pausedReason).toBe(reason);
		expect(desk.pausedByName, 'the page names who stopped it').toBeTruthy();

		// The others are untouched: a pause is per agent unless it is 'all'.
		const assistant = paused.find((r) => r.agent === 'assistant')!;
		expect(assistant.paused).toBe(false);

		// Letting it go is the administrator's.
		await expect(
			setPause(db, DANA, {
				agent: 'order_desk',
				paused: false,
				reason: '',
				requestId: `trust-release-${randomUUID()}`
			})
		).rejects.toMatchObject({ status: 403 });

		await setPause(db, ADMIN, {
			agent: 'order_desk',
			paused: false,
			reason: '',
			requestId: `trust-release-ok-${randomUUID()}`
		});
		const running = await readAgentTrust(db, ADMIN);
		expect(running.find((r) => r.agent === 'order_desk')!.paused).toBe(false);
	});

	it('reads a global pause as every agent stopped', async () => {
		await setPause(db, DANA, {
			agent: 'all',
			paused: true,
			reason: 'Everything off while we look at something.',
			requestId: `trust-pause-all-${randomUUID()}`
		});

		const rows = await readAgentTrust(db, ADMIN);
		for (const row of rows) {
			expect(row.paused, `${row.agent} under a global pause`).toBe(true);
		}

		await setPause(db, ADMIN, {
			agent: 'all',
			paused: false,
			reason: '',
			requestId: `trust-release-all-${randomUUID()}`
		});
		const after = await readAgentTrust(db, ADMIN);
		for (const row of after) expect(row.paused, `${row.agent} let go`).toBe(false);
	});
});

describe('the refusals carry the rule that refused', () => {
	it('names every check in the registry with where it is really enforced', () => {
		const roster = guardrailRoster();
		expect(roster.length).toBeGreaterThan(10);
		for (const check of roster) {
			expect(check.checkId).toMatch(/^[a-z][a-z_]+$/);
			expect(check.description.length, `${check.checkId} says what it does`).toBeGreaterThan(10);
			// The registry names and counts the checks; the FEATURE enforces
			// them. Every entry has to say where, or the page cannot be checked.
			expect(check.enforcedIn.length, `${check.checkId} says where`).toBeGreaterThan(5);
			expect(check.agents.length).toBeGreaterThan(2);
		}
	});

	it('reads as an empty list on a world where nothing has been refused', async () => {
		const refusals = await readRefusals(db, ADMIN, 12);
		// Every refusal listed must carry its rule, whether there are none or
		// twenty. A count with no rule beside it is not an argument.
		for (const refusal of refusals) {
			expect(refusal.rule.length).toBeGreaterThan(5);
			expect(refusal.enforcedIn.length).toBeGreaterThan(3);
			expect(refusal.times).toBeGreaterThan(0);
		}
	});
});

describe('the eval summary is the eval runner own figures', () => {
	it('matches the baseline the eval test holds the suites to', () => {
		const baseline = readBaseline();
		expect(baseline, 'evals/agents/baseline.json is on file').toBeTruthy();

		const summary = readEvalSummary(baseline);
		expect(summary.suites.length).toBeGreaterThanOrEqual(Object.keys(baseline!).length);

		for (const suite of summary.suites) {
			const recorded = baseline![suite.suite];
			expect(recorded, `${suite.suite} is in the baseline`).toBeTruthy();
			expect(suite.baselineCases).toBe(recorded.cases);
			expect(suite.baselinePassed).toBe(recorded.passed);
		}
	});

	it('shows the baseline, labelled, when no run artifact is on file', () => {
		const summary = readEvalSummary();
		// The artifact is written by the runner and is not committed, so a
		// fresh checkout has a baseline and no run. The page must show the
		// baseline and say that is what it is: zeros would say the evals do
		// not exist, which is the worst thing this page could get wrong.
		expect(['run', 'baseline']).toContain(summary.source);
		if (summary.source === 'baseline') {
			expect(summary.ranOn).toBeNull();
			for (const suite of summary.suites) {
				expect(suite.passed, `${suite.suite} shows its baseline pass count`).toBe(
					suite.baselinePassed
				);
			}
			expect(summary.passed).toBeGreaterThan(0);
		}
	});

	it('counts the case files with the runner own loaders, so a link is never a guess', () => {
		const summary = readEvalSummary();
		for (const suite of summary.suites) {
			expect(suite.folder).toBe(caseFolder(suite.suite));
			// The desk suite keeps its cases as text with the expectation
			// beside it; the other three are one JSON file each.
			const onDisk =
				suite.folder === 'desk'
					? loadTextCases<unknown>(suite.folder).map((c) => c.name)
					: loadJsonCases<unknown>(suite.folder).map((c) => c.name);
			expect(suite.caseNames, `${suite.suite} case names`).toEqual(onDisk);
			for (const name of suite.caseNames) {
				// The route into a case checks this pattern before it touches
				// the file system, so every real case must match it.
				expect(name).toMatch(/^\d{2}-[a-z0-9-]+$/);
			}
		}
	});

	it('reports the dated write-up a person can open', () => {
		const summary = readEvalSummary();
		expect(summary.reportPath).toMatch(/^evals\/agents\/reports\/\d{4}-\d{2}-\d{2}\.md$/);
	});
});
