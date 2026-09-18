// The history behind a commitment: quote versions, the conditions they
// carry, the trail of answers and the next steps somebody owes.
//
// The first half builds its own commitments on its own customers, so no test
// reads another's rows. The second half asserts the shape of the seeded
// world: not exact counts, which would break every time the generator is
// touched, but bands and a spread. A seed change that gives every commitment
// one quote and one next step is a change that made the data look generated,
// and it has to fail here.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type WorldSize } from '../db/pglite.ts';
import type { Db } from '../db/types.ts';
import { getAccountRecord, getCommitmentDepth } from './depth.ts';

const ADMIN = 1;
const DANA = 2;

let db: Db;
let seq = 0;

beforeAll(async () => {
	db = await createTestDb();
	await db.asSystem(async (tx) => {
		for (const item of ['ZD-100', 'ZD-200', 'ZD-300']) {
			await tx.sql`insert into nl.items (item_no, description, category, family, product_group,
			                                   unit_cost, list_price, replenishment)
			             values (${item}, 'DEPTH TEST PART', 'PIPE', 'pipe', 'PIPE', 10, 40, 'Prod. Order')`;
		}
	});
});

afterAll(async () => {
	await db?.close();
});

interface Fixture {
	customerNo: string;
	commitmentId: number;
	quoteId: number;
}

/** A customer, a commitment on it for two parts, and one quote for it. */
async function fixture(options: { startsOn?: string; endsOn?: string; value?: number } = {}): Promise<Fixture> {
	seq += 1;
	const customerNo = `D${seq}-HQ`;
	return db.asSystem(async (tx) => {
		await tx.sql`insert into nl.customers (customer_no, name, price_group, owner_id, customer_since)
		             values (${customerNo}, 'Depth Test Fleet', 'DEALER', ${DANA}, '2020-01-01')`;
		const [c] = await tx.sql<{ id: number }>`
			insert into nl.commitments (title, customer_no, owner_id, committed_value, starts_on, ends_on, created_by)
			values ('Depth test commitment', ${customerNo}, ${DANA}, ${options.value ?? 50000},
			        ${options.startsOn ?? '2026-01-01'}, ${options.endsOn ?? '2026-06-30'}, ${DANA})
			returning id`;
		await tx.sql`insert into nl.commitment_items (commitment_id, item_no, quantity)
		             values (${c.id}, 'ZD-100', 40), (${c.id}, 'ZD-200', 10)`;
		const [q] = await tx.sql<{ id: number }>`
			insert into nl.quotes (customer_no, commitment_id, quoted_on, source, created_by)
			values (${customerNo}, ${c.id}, '2026-01-05', 'seed', ${DANA})
			returning id`;
		return { customerNo, commitmentId: c.id, quoteId: q.id };
	});
}

/** One version of a quote, with one line per item given. */
async function revision(
	quoteId: number,
	version: number,
	options: {
		revisedOn: string;
		changeReason?: string;
		outcome?: string;
		outcomeReason?: string | null;
		outcomeNote?: string;
		decidedOn?: string | null;
		lines?: { itemNo: string; quantity: number; unitPrice: number }[];
	}
): Promise<number> {
	const reason = options.changeReason ?? (version === 1 ? 'first issue' : 'price increase');
	const outcome = options.outcome ?? 'open';
	return db.asSystem(async (tx) => {
		const [r] = await tx.sql<{ id: number }>`
			insert into nl.quote_revisions (quote_id, version, revised_on, sent_by, valid_from, valid_until,
			                                change_reason, outcome, outcome_reason, outcome_note, decided_on)
			values (${quoteId}, ${version}, ${options.revisedOn}, ${DANA}, ${options.revisedOn},
			        ${options.revisedOn}::date + 30, ${reason}, ${outcome},
			        ${options.outcomeReason ?? null},
			        ${options.outcomeNote ?? ''},
			        ${options.decidedOn ?? (outcome === 'open' ? null : options.revisedOn)})
			returning id`;
		const lines = options.lines ?? [{ itemNo: 'ZD-100', quantity: 40, unitPrice: 100 }];
		for (const [index, line] of lines.entries()) {
			await tx.sql`insert into nl.quote_revision_lines (revision_id, line_no, item_no, quantity, unit_price, price_rule)
			             values (${r.id}, ${index + 1}, ${line.itemNo}, ${line.quantity}, ${line.unitPrice}, 'group discount')`;
		}
		return r.id;
	});
}

// ---------------------------------------------------------------------------

describe('quote revisions', () => {
	it('come back newest version first, and the latest version is the one that counts', async () => {
		const f = await fixture();
		// Inserted out of order on purpose: version order must come from the
		// version column, not from the order somebody happened to write them.
		await revision(f.quoteId, 2, {
			revisedOn: '2026-01-20',
			lines: [{ itemNo: 'ZD-100', quantity: 40, unitPrice: 110 }]
		});
		await revision(f.quoteId, 3, {
			revisedOn: '2026-02-02',
			changeReason: 'quantity break',
			lines: [{ itemNo: 'ZD-100', quantity: 80, unitPrice: 104 }]
		});
		await revision(f.quoteId, 1, {
			revisedOn: '2026-01-05',
			lines: [{ itemNo: 'ZD-100', quantity: 40, unitPrice: 100 }]
		});

		const depth = await getCommitmentDepth(db, DANA, f.commitmentId);
		const quote = depth.quotes.find((q) => q.id === f.quoteId)!;
		expect(quote.revisions.map((r) => r.version)).toEqual([3, 2, 1]);
		expect(quote.revisions[0].isLatest).toBe(true);
		expect(quote.revisions.slice(1).every((r) => !r.isLatest)).toBe(true);
		// The quote's total is the latest version's, 80 at 104, not the first.
		expect(quote.total).toBe(8320);
		expect(quote.versions).toBe(3);
	});

	it('say what changed from the version before, not only that something did', async () => {
		const f = await fixture();
		await revision(f.quoteId, 1, {
			revisedOn: '2026-01-05',
			lines: [
				{ itemNo: 'ZD-100', quantity: 40, unitPrice: 100 },
				{ itemNo: 'ZD-200', quantity: 10, unitPrice: 200 }
			]
		});
		await revision(f.quoteId, 2, {
			revisedOn: '2026-01-25',
			lines: [
				{ itemNo: 'ZD-100', quantity: 60, unitPrice: 105 },
				{ itemNo: 'ZD-300', quantity: 5, unitPrice: 300 }
			]
		});

		const depth = await getCommitmentDepth(db, DANA, f.commitmentId);
		const changes = depth.quotes.find((q) => q.id === f.quoteId)!.revisions[0].changes.map((c) => c.text);
		expect(changes).toContain('ZD-100 price up 5%, $100 to $105');
		expect(changes).toContain('ZD-100 quantity 40 to 60');
		expect(changes.some((t) => t.startsWith('ZD-300 added'))).toBe(true);
		expect(changes).toContain('ZD-200 taken off the quote');
		// Version 1 has nothing to compare against.
		expect(depth.quotes.find((q) => q.id === f.quoteId)!.revisions[1].changes).toEqual([]);
	});

	it('records a loss with a reason from the vocabulary, and refuses a free-text reason on its own', async () => {
		const f = await fixture();
		await revision(f.quoteId, 1, { revisedOn: '2026-01-05' });
		await revision(f.quoteId, 2, {
			revisedOn: '2026-02-01',
			outcome: 'lost',
			outcomeReason: 'price',
			outcomeNote: 'Beaten by about six points.'
		});

		const depth = await getCommitmentDepth(db, DANA, f.commitmentId);
		const quote = depth.quotes.find((q) => q.id === f.quoteId)!;
		expect(quote.outcome).toBe('lost');
		expect(quote.lostReason).toBe('price');
		expect(quote.revisions[0].outcomeNote).toContain('six points');

		// A note is not a reason: it cannot be counted, and counting losses by
		// reason is the point of having the column.
		await expect(
			revision(f.quoteId, 3, {
				revisedOn: '2026-03-01',
				outcome: 'lost',
				outcomeReason: null,
				outcomeNote: 'They went somewhere else, I think on price.'
			})
		).rejects.toThrow(/quote_revisions_loss_has_a_reason/);

		// Nor is a reason somebody invented on the spot.
		await expect(
			revision(f.quoteId, 4, {
				revisedOn: '2026-03-01',
				outcome: 'lost',
				outcomeReason: 'they liked the other rep'
			})
		).rejects.toThrow(/quote_revisions_reason_known/);
	});

	it('refuses a first issue that is not version one, and a version one that is not a first issue', async () => {
		const f = await fixture();
		await expect(revision(f.quoteId, 2, { revisedOn: '2026-02-01', changeReason: 'first issue' })).rejects.toThrow(
			/quote_revisions_first_issue_is_version_one/
		);
		await expect(revision(f.quoteId, 1, { revisedOn: '2026-01-05', changeReason: 'lead time' })).rejects.toThrow(
			/quote_revisions_first_issue_is_version_one/
		);
	});
});

describe('requirements', () => {
	it('shows a condition on a won quote as unsatisfied until somebody meets it', async () => {
		const f = await fixture();
		await revision(f.quoteId, 1, { revisedOn: '2026-01-05', outcome: 'won', decidedOn: '2026-01-12' });
		const [r] = await db.asSystem((tx) =>
			tx.sql<{ id: number }>`
				insert into nl.requirements (quote_id, kind, party, detail, required_by, created_by)
				values (${f.quoteId}, 'certificate_of_conformance', 'us',
				        'Certificate with every shipment.', '2026-02-01', ${DANA})
				returning id`
		);

		let depth = await getCommitmentDepth(db, DANA, f.commitmentId);
		expect(depth.quotes.find((q) => q.id === f.quoteId)!.outcome).toBe('won');
		let condition = depth.requirements.find((x) => x.id === r.id)!;
		expect(condition.satisfied).toBe(false);
		// Due 2026-02-01, and the world's today is 2026-09-17.
		expect(condition.overdue).toBe(true);

		await db.asSystem(
			(tx) => tx.sql`update nl.requirements
			               set satisfied_on = '2026-01-20', satisfied_by = ${DANA},
			                   satisfied_note = 'Sent with the first shipment.'
			               where id = ${r.id}`
		);

		depth = await getCommitmentDepth(db, DANA, f.commitmentId);
		condition = depth.requirements.find((x) => x.id === r.id)!;
		expect(condition.satisfied).toBe(true);
		expect(condition.overdue).toBe(false);
		expect(condition.satisfiedByName).toBeTruthy();
	});

	it('insists each kind carries the attribute that makes it actionable', async () => {
		const f = await fixture();
		// A price hold with no date is not a price hold.
		await expect(
			db.asSystem(
				(tx) => tx.sql`insert into nl.requirements (commitment_id, kind, created_by)
				               values (${f.commitmentId}, 'price_hold', ${DANA})`
			)
		).rejects.toThrow(/requirements_price_hold_has_a_date/);
		// A minimum order with no figure is not a minimum.
		await expect(
			db.asSystem(
				(tx) => tx.sql`insert into nl.requirements (commitment_id, kind, created_by)
				               values (${f.commitmentId}, 'minimum_order', ${DANA})`
			)
		).rejects.toThrow(/requirements_minimum_order_has_a_figure/);
		// And it belongs to a quote or a commitment, never both and never neither.
		await expect(
			db.asSystem(
				(tx) => tx.sql`insert into nl.requirements (commitment_id, quote_id, kind, terms_code, created_by)
				               values (${f.commitmentId}, ${f.quoteId}, 'delivery_terms', 'FOB origin', ${DANA})`
			)
		).rejects.toThrow(/requirements_attached_to_one/);
	});
});

describe('the outcome trail', () => {
	it('comes back in date order, with what was promised and what had arrived', async () => {
		const f = await fixture({ startsOn: '2025-01-01', endsOn: '2025-06-30', value: 40000 });
		await db.asSystem(async (tx) => {
			// Written newest first, read oldest first.
			await tx.sql`insert into nl.commitment_outcomes (commitment_id, outcome, source, answered_by,
			                                                 answered_at, note, window_starts_on, window_ends_on,
			                                                 committed_value, delivered_value, reason)
			             values (${f.commitmentId}, 'broken', 'person', ${DANA}, '2025-09-01T15:00:00Z',
			                     'Not coming after all.', '2025-01-01', '2025-06-30', 40000, 9000, 'competitor')`;
			await tx.sql`insert into nl.commitment_outcomes (commitment_id, outcome, source, answered_by,
			                                                 answered_at, note, window_starts_on, window_ends_on,
			                                                 committed_value, delivered_value, reason)
			             values (${f.commitmentId}, 'pushed', 'person', ${DANA}, '2025-07-10T15:00:00Z',
			                     'Buyer says it is still coming.', '2025-01-01', '2025-06-30', 40000, 9000, 'no decision')`;
		});

		const depth = await getCommitmentDepth(db, DANA, f.commitmentId);
		expect(depth.outcomes.map((o) => o.outcome)).toEqual(['pushed', 'broken']);
		expect(depth.outcomes[0].committedValue).toBe(40000);
		expect(depth.outcomes[0].deliveredValue).toBe(9000);
		expect(depth.outcomes[0].reason).toBe('no decision');
		expect(depth.outcomes[1].windowEndsOn).toBe('2025-06-30');
	});

	it('opens the next window when an answer says the business moved to one', async () => {
		const f = await fixture({ startsOn: '2025-01-01', endsOn: '2025-06-30', value: 40000 });
		await db.asSystem(
			(tx) => tx.sql`insert into nl.commitment_outcomes (commitment_id, outcome, source, answered_by,
			                                                   answered_at, window_starts_on, window_ends_on,
			                                                   committed_value, delivered_value, reason,
			                                                   pushed_to_starts_on, pushed_to_ends_on)
			               values (${f.commitmentId}, 'pushed', 'person', ${DANA}, '2025-07-10T15:00:00Z',
			                       '2025-01-01', '2025-06-30', 40000, 9000, 'no decision',
			                       '2025-08-01', '2025-12-31')`
		);

		const depth = await getCommitmentDepth(db, DANA, f.commitmentId);
		const moved = depth.outcomes[0];
		expect(moved.pushedToEndsOn).toBe('2025-12-31');
		expect(moved.nextCommitmentId).toBeTruthy();

		const [next] = await db.asSystem(
			(tx) => tx.sql<{
				customer_no: string;
				committed_value: number;
				starts_on: string;
				ends_on: string;
				items: string[];
			}>`
				select c.customer_no, c.committed_value, c.starts_on, c.ends_on,
				       array(select ci.item_no from nl.commitment_items ci
				             where ci.commitment_id = c.id order by ci.item_no) as items
				from nl.commitments c where c.id = ${moved.nextCommitmentId}`
		);
		expect(next.customer_no).toBe(f.customerNo);
		// Worth what the first window did not deliver, carrying the same parts.
		expect(next.committed_value).toBe(31000);
		expect(next.starts_on).toBe('2025-08-01');
		expect(next.ends_on).toBe('2025-12-31');
		expect(next.items).toEqual(['ZD-100', 'ZD-200']);
	});

	it('refuses a new window on an answer that is not a push', async () => {
		const f = await fixture({ startsOn: '2025-01-01', endsOn: '2025-06-30' });
		await expect(
			db.asSystem(
				(tx) => tx.sql`insert into nl.commitment_outcomes (commitment_id, outcome, source, answered_by,
				                                                   pushed_to_starts_on, pushed_to_ends_on)
				               values (${f.commitmentId}, 'kept', 'person', ${DANA}, '2025-08-01', '2025-12-31')`
			)
		).rejects.toThrow(/outcomes_new_window_only_when_pushed/);
		// A kept window has no reason to give either.
		await expect(
			db.asSystem(
				(tx) => tx.sql`insert into nl.commitment_outcomes (commitment_id, outcome, source, answered_by, reason)
				               values (${f.commitmentId}, 'kept', 'person', ${DANA}, 'price')`
			)
		).rejects.toThrow(/outcomes_reason_where_it_fits/);
	});

	it('keeps the figures as they stood when a person answers through nl.record_outcome', async () => {
		const f = await fixture({ startsOn: '2026-01-01', endsOn: '2026-03-31', value: 20000 });
		const [row] = await db.asUser(DANA, (tx) =>
			tx.sql<{ updated_at: Date }>`select updated_at from nl.commitments where id = ${f.commitmentId}`
		);
		await db.asUser(DANA, (tx) =>
			tx.sql`select nl.record_outcome(${f.commitmentId}, 'broken', ${row.updated_at.toISOString()}::timestamptz,
			                                ${`depth-test-${f.commitmentId}`}, 'Lost the program.')`
		);
		const depth = await getCommitmentDepth(db, DANA, f.commitmentId);
		expect(depth.outcomes).toHaveLength(1);
		expect(depth.outcomes[0].windowStartsOn).toBe('2026-01-01');
		expect(depth.outcomes[0].windowEndsOn).toBe('2026-03-31');
		expect(depth.outcomes[0].committedValue).toBe(20000);
		expect(depth.outcomes[0].deliveredValue).toBe(0);
	});
});

describe('next steps', () => {
	/** One step on a commitment. */
	async function step(
		f: Fixture,
		options: { dueOn: string | null; source?: 'person' | 'agent'; agent?: string; kind?: string }
	): Promise<number> {
		const [s] = await db.asSystem((tx) =>
			tx.sql<{ id: number }>`
				insert into nl.next_steps (customer_no, commitment_id, title, kind, source, agent, due_on,
				                           owner_id, created_by)
				values (${f.customerNo}, ${f.commitmentId}, 'A step', ${options.kind ?? 'call'},
				        ${options.source ?? 'person'}, ${options.agent ?? null}, ${options.dueOn}, ${DANA}, ${DANA})
				returning id`
		);
		return s.id;
	}

	it('tells an agent proposal from a person one in a query, and insists the agent is named', async () => {
		const f = await fixture();
		const byPerson = await step(f, { dueOn: '2026-10-01' });
		const byAgent = await step(f, { dueOn: '2026-10-01', source: 'agent', agent: 'order desk' });

		const proposed = await db.asUser(DANA, (tx) =>
			tx.sql<{ id: number; agent: string }>`
				select id, agent from nl.next_steps
				where commitment_id = ${f.commitmentId} and source = 'agent'`
		);
		expect(proposed.map((r) => r.id)).toEqual([byAgent]);
		expect(proposed[0].agent).toBe('order desk');

		const depth = await getCommitmentDepth(db, DANA, f.commitmentId);
		expect(depth.steps.find((s) => s.id === byPerson)!.source).toBe('person');
		expect(depth.steps.find((s) => s.id === byAgent)!.agent).toBe('order desk');

		// An agent with no name, or a person with one, is a row nobody can audit.
		await expect(step(f, { dueOn: '2026-10-01', source: 'agent' })).rejects.toThrow(/next_steps_agent_is_named/);
		await expect(step(f, { dueOn: '2026-10-01', agent: 'order desk' })).rejects.toThrow(
			/next_steps_agent_is_named/
		);
	});

	it('is overdue against the company date, not the server clock', async () => {
		// This world's today is the middle of January, while the machine
		// running the test is somewhere else in the calendar. A step due in
		// June is therefore in the future here and in the past by the clock.
		const other = await createTestDb({ today: '2026-01-15' });
		try {
			await other.asSystem(async (tx) => {
				await tx.sql`insert into nl.items (item_no, description, category, family, product_group,
				                                   unit_cost, list_price, replenishment)
				             values ('ZD-900', 'DEPTH TEST PART', 'PIPE', 'pipe', 'PIPE', 10, 40, 'Prod. Order')`;
				await tx.sql`insert into nl.customers (customer_no, name, price_group, owner_id, customer_since)
				             values ('D9-HQ', 'Depth Clock Fleet', 'DEALER', ${DANA}, '2020-01-01')`;
				const [c] = await tx.sql<{ id: number }>`
					insert into nl.commitments (title, customer_no, owner_id, committed_value, starts_on, ends_on, created_by)
					values ('Clock test', 'D9-HQ', ${DANA}, 10000, '2026-01-01', '2026-12-31', ${DANA})
					returning id`;
				await tx.sql`insert into nl.commitment_items (commitment_id, item_no) values (${c.id}, 'ZD-900')`;
				await tx.sql`insert into nl.next_steps (customer_no, commitment_id, title, kind, due_on, owner_id, created_by)
				             values ('D9-HQ', ${c.id}, 'Owed since before today', 'call', '2026-01-10', ${DANA}, ${DANA}),
				                    ('D9-HQ', ${c.id}, 'Due today', 'call', '2026-01-15', ${DANA}, ${DANA}),
				                    ('D9-HQ', ${c.id}, 'Due in June', 'call', '2026-06-01', ${DANA}, ${DANA})`;
			});
			const [{ id }] = await other.asSystem(
				(tx) => tx.sql<{ id: number }>`select id from nl.commitments where customer_no = 'D9-HQ'`
			);
			const depth = await getCommitmentDepth(other, DANA, id);
			const byTitle = new Map(depth.steps.map((s) => [s.title, s]));
			expect(depth.today).toBe('2026-01-15');
			expect(byTitle.get('Owed since before today')!.overdue).toBe(true);
			expect(byTitle.get('Due today')!.dueToday).toBe(true);
			expect(byTitle.get('Due today')!.overdue).toBe(false);
			// The line that would fail if the code read the wall clock.
			expect(byTitle.get('Due in June')!.overdue).toBe(false);
		} finally {
			await other.close();
		}
	});
});

describe('access', () => {
	it('keeps nl.commitment_depth away from the read-only role, because it counts calls', async () => {
		// The view reads nl.activities, which is a table about people, so the
		// assistant's read-only role has no grant anywhere on that path.
		await expect(db.asReadonly((tx) => tx.sql`select count(*) from nl.commitment_depth`)).rejects.toThrow(
			/permission denied/
		);
		// The record itself is about money and dates, so it may read that.
		const rows = await db.asReadonly(
			(tx) => tx.sql<{ n: number }>`select count(*)::int as n from nl.account_sales_record`
		);
		expect(rows[0].n).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// The seeded world
// ---------------------------------------------------------------------------

/**
 * Which worlds the shape assertions run against.
 *
 * `small` and `demo` run every time. `full` takes about twenty minutes to
 * build in PGlite, so it is opt in: `NL_WORLD_SIZES=small,demo,full npx
 * vitest run src/lib/server/commitments`. The figures for all three are in
 * docs/commitments.md.
 */
const SIZES = (process.env.NL_WORLD_SIZES ?? 'small,demo').split(',') as WorldSize[];

interface Shape {
	commitments: number;
	quotes: number;
	revisions: number;
	requirements: number;
	steps: number;
	answers: number;
	activity: number;
	agentSteps: number;
	openSteps: number;
	overdueSteps: number;
	quotesPerCommitment: Record<number, number>;
	versionsPerQuote: Record<number, number>;
	stepsPerCommitment: Record<number, number>;
	bare: number;
	withTwoQuotes: number;
	withRequirements: number;
	lostWithReason: number;
	wonQuotes: number;
	settledPerAccount: Record<number, number>;
	worstKeptRate: number | null;
}

async function shapeOf(world: Db): Promise<Shape> {
	return world.asSystem(async (tx) => {
		const [totals] = await tx.sql<{
			commitments: number;
			quotes: number;
			revisions: number;
			requirements: number;
			steps: number;
			answers: number;
			activity: number;
			agent_steps: number;
			open_steps: number;
			overdue_steps: number;
		}>`
			select
			  (select count(*) from nl.commitments)::int as commitments,
			  (select count(*) from nl.quotes)::int as quotes,
			  (select count(*) from nl.quote_revisions)::int as revisions,
			  (select count(*) from nl.requirements)::int as requirements,
			  (select count(*) from nl.next_steps where commitment_id is not null)::int as steps,
			  (select count(*) from nl.commitment_outcomes)::int as answers,
			  (select count(*) from nl.activities where commitment_id is not null)::int as activity,
			  (select count(*) from nl.next_steps
			    where commitment_id is not null and source = 'agent')::int as agent_steps,
			  (select count(*) from nl.next_steps
			    where commitment_id is not null and completed_at is null)::int as open_steps,
			  (select count(*) from nl.next_steps
			    where commitment_id is not null and completed_at is null and due_on < nl.today())::int as overdue_steps`;

		const histogram = async (sql: Promise<{ n: number; rows: number }[]>) =>
			Object.fromEntries((await sql).map((r) => [r.n, r.rows])) as Record<number, number>;

		const quotesPerCommitment = await histogram(
			tx.sql<{ n: number; rows: number }>`
				select n, count(*)::int as rows from (
				  select c.id, count(q.id)::int as n
				  from nl.commitments c left join nl.quotes q on q.commitment_id = c.id
				  group by c.id) s
				group by n`
		);
		const versionsPerQuote = await histogram(
			tx.sql<{ n: number; rows: number }>`
				select versions::int as n, count(*)::int as rows from nl.quote_state group by versions`
		);
		const stepsPerCommitment = await histogram(
			tx.sql<{ n: number; rows: number }>`
				select n, count(*)::int as rows from (
				  select c.id, count(s.id)::int as n
				  from nl.commitments c left join nl.next_steps s on s.commitment_id = c.id
				  group by c.id) s
				group by n`
		);
		const settledPerAccount = await histogram(
			tx.sql<{ n: number; rows: number }>`
				select settled_count::int as n, count(*)::int as rows
				from nl.account_sales_record where settled_count > 0 group by settled_count`
		);

		const [spread] = await tx.sql<{
			bare: number;
			with_two_quotes: number;
			with_requirements: number;
		}>`
			select count(*) filter (where is_bare)::int as bare,
			       count(*) filter (where quote_count >= 2)::int as with_two_quotes,
			       count(*) filter (where requirements > 0)::int as with_requirements
			from nl.commitment_depth`;

		const [quoteEnds] = await tx.sql<{ lost_with_reason: number; won: number }>`
			select count(*) filter (where outcome = 'lost' and lost_reason is not null)::int as lost_with_reason,
			       count(*) filter (where outcome = 'won')::int as won
			from nl.quote_state`;

		const [worst] = await tx.sql<{ kept_rate: number | null }>`
			select min(kept_rate) as kept_rate from nl.account_sales_record where settled_count >= 3`;

		return {
			commitments: totals.commitments,
			quotes: totals.quotes,
			revisions: totals.revisions,
			requirements: totals.requirements,
			steps: totals.steps,
			answers: totals.answers,
			activity: totals.activity,
			agentSteps: totals.agent_steps,
			openSteps: totals.open_steps,
			overdueSteps: totals.overdue_steps,
			quotesPerCommitment,
			versionsPerQuote,
			stepsPerCommitment,
			bare: spread.bare,
			withTwoQuotes: spread.with_two_quotes,
			withRequirements: spread.with_requirements,
			lostWithReason: quoteEnds.lost_with_reason,
			wonQuotes: quoteEnds.won,
			settledPerAccount,
			worstKeptRate: worst.kept_rate
		};
	});
}

/** The share of `total` that the biggest bucket of a histogram holds. */
function topShare(histogram: Record<number, number>): number {
	const counts = Object.values(histogram);
	const total = counts.reduce((sum, n) => sum + n, 0);
	return total === 0 ? 1 : Math.max(...counts) / total;
}

describe.each(SIZES)('the seeded %s world', (size) => {
	let world: Db;
	let shape: Shape;

	beforeAll(async () => {
		world = await createTestDb({ size });
		shape = await shapeOf(world);
	}, 1_500_000);

	afterAll(async () => {
		await world?.close();
	});

	it('has each count inside a band rather than at an exact number', () => {
		const per = (n: number) => n / shape.commitments;
		// Bands, not numbers: a generator change may move any of these, and
		// only a change that moves one out of its band is a change of shape.
		expect(per(shape.quotes)).toBeGreaterThan(0.5);
		expect(per(shape.quotes)).toBeLessThan(1.5);
		expect(shape.revisions / shape.quotes).toBeGreaterThan(1.1);
		expect(shape.revisions / shape.quotes).toBeLessThan(2.6);
		expect(per(shape.requirements)).toBeGreaterThan(0.3);
		expect(per(shape.requirements)).toBeLessThan(1.6);
		expect(per(shape.steps)).toBeGreaterThan(0.4);
		expect(per(shape.steps)).toBeLessThan(2.2);
		expect(per(shape.activity)).toBeGreaterThan(0.8);
		expect(per(shape.activity)).toBeLessThan(6);
		// A meaningful share of the open work is an agent's suggestion, which
		// is what the trust surfaces measure.
		expect(shape.agentSteps / shape.steps).toBeGreaterThan(0.12);
		expect(shape.agentSteps / shape.steps).toBeLessThan(0.55);
		// Some of it is late. None of it being late is as fake as all of it.
		expect(shape.overdueSteps).toBeGreaterThan(0);
		expect(shape.overdueSteps / shape.openSteps).toBeLessThan(0.7);
		// Losses are countable, and not everything was won.
		expect(shape.lostWithReason).toBeGreaterThan(0);
		expect(shape.wonQuotes).toBeGreaterThan(0);
		expect(shape.answers).toBeGreaterThan(1);
	});

	it('gives no two commitments the same shape', () => {
		// An even spread is the tell of generated data, so the histograms have
		// to be lumpy: several distinct sizes, and no single size holding most
		// of the world.
		expect(Object.keys(shape.quotesPerCommitment).length).toBeGreaterThan(2);
		expect(topShare(shape.quotesPerCommitment)).toBeLessThan(0.75);
		expect(Object.keys(shape.stepsPerCommitment).length).toBeGreaterThan(2);
		expect(topShare(shape.stepsPerCommitment)).toBeLessThan(0.75);
		expect(Object.keys(shape.versionsPerQuote).length).toBeGreaterThan(1);
		expect(topShare(shape.versionsPerQuote)).toBeLessThan(0.8);

		// Both ends exist: commitments with nothing behind them, and
		// commitments carrying several quotes and a checklist.
		expect(shape.bare).toBeGreaterThan(0);
		expect(shape.withTwoQuotes).toBeGreaterThan(0);
		expect(shape.withRequirements).toBeGreaterThan(0);
		expect(shape.quotesPerCommitment[0]).toBeGreaterThan(0);
		expect(shape.stepsPerCommitment[0]).toBeGreaterThan(0);
	});

	it('gives some accounts a record worth reading, including a bad one', () => {
		// An account with three or more settled windows is one a person can
		// read a pattern off, and at least one of them keeps a poor record.
		const withARecord = Object.entries(shape.settledPerAccount)
			.filter(([n]) => Number(n) >= 3)
			.reduce((sum, [, rows]) => sum + rows, 0);
		expect(withARecord).toBeGreaterThan(0);
		expect(shape.worstKeptRate).not.toBeNull();
		expect(shape.worstKeptRate!).toBeLessThan(0.7);
	});

	it('leaves the stored delivered figure in agreement with a fresh count', async () => {
		// Migration 0027 adds commitments and answers during the build, which
		// the 0008 triggers have to keep up with.
		const drift = await world.asSystem((tx) => tx.sql<{ n: number }>`select count(*)::int as n from nl.delivery_drift()`);
		expect(drift[0].n).toBe(0);
	});

	it('reads an account record back through the same code the page uses', async () => {
		const [pick] = await world.asSystem(
			(tx) => tx.sql<{ customer_no: string }>`
				select customer_no from nl.account_sales_record
				where settled_count >= 2 order by settled_count desc, customer_no limit 1`
		);
		const record = await getAccountRecord(world, ADMIN, pick.customer_no);
		expect(record.settledCount).toBeGreaterThan(1);
		expect(record.kept + record.pushed + record.broken).toBe(record.settledCount);
		expect(record.pattern.length).toBeGreaterThan(1);
		expect(record.pattern.length).toBeLessThan(9);
	});
});
