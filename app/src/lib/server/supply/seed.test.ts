// What a fresh world comes with: two mornings of all three exports, applied,
// so the forecast page has something to show and the demo has today's files
// to upload (db/seed.d/40_supply.sql and the generators in migration 0016).
//
// This file does not empty anything: it reads the world as the seed left it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Rule } from '$lib/automation/catalog';
import { testRule } from '../automation/rules.ts';
import { createTestDb } from '../db/pglite.ts';
import type { Db } from '../db/types.ts';
import { sampleFile } from '../exports/samples.ts';
import { readReport } from '../exports/reports.ts';
import { decideExport, getSnapshotReview, uploadExport } from '../exports/snapshots.ts';
import { getForecast, readFilters } from './forecast.ts';
import type { SampleKind } from '$lib/components/exports/types';

const ADMIN = 1;
const DANA = 2; // account manager
const PRIYA = 5; // operations
const TODAY = '2026-09-17';

let db: Db;

beforeAll(async () => {
	db = await createTestDb();
});

afterAll(async () => {
	await db?.close();
});

describe('the world the seed leaves', () => {
	it('applies two mornings of each report, the later one live', async () => {
		const rows = await db.asSystem((tx) =>
			tx.sql<{ kind: string; day: string; status: string; is_current: boolean; row_count: number }>`
				select kind, (staged_at at time zone 'America/Chicago')::date as day, status, is_current, row_count
				from nl.export_snapshots order by id`
		);
		expect(rows).toHaveLength(6);
		expect(rows.every((r) => r.status === 'applied')).toBe(true);
		expect(rows.filter((r) => r.is_current).map((r) => r.kind).sort()).toEqual([
			'open_production_orders',
			'open_purchase_lines',
			'open_sales_lines'
		]);
		// The day before yesterday, then yesterday. Today is what the demo loads.
		expect([...new Set(rows.map((r) => r.day))]).toEqual(['2026-09-15', '2026-09-16']);
		expect(rows.every((r) => r.row_count > 0)).toBe(true);

		const [live] = await db.asSystem((tx) =>
			tx.sql<{ sales: number; purchase: number; production: number }>`
				select (select count(*) from nl.open_order_lines) as sales,
				       (select count(*) from nl.open_purchase_lines) as purchase,
				       (select count(*) from nl.open_production_orders) as production`
		);
		expect(live.sales).toBeGreaterThan(80);
		expect(live.purchase).toBeGreaterThan(10);
		expect(live.production).toBeGreaterThan(10);
	});

	it('covers most of its demand, so the mix of statuses looks like a real order book', async () => {
		// Supply is planned against demand (migration 0022): what the shelf does
		// not cover becomes a requirement, most requirements are on order, and
		// the dates decide who is late. The bands below are what that produces
		// on the small world; they are wide enough for the world to move a
		// little and tight enough to catch the failure they were written for,
		// which was 57% of lines with nothing on order at all.
		//
		// The shares are read off nl.open_line_projection, the same view the
		// page reads, so this is the mix a person would see.
		const mix = await db.asUser(DANA, (tx) =>
			tx.sql<{ status: string; lines: number; pct: number }>`
				select status, count(*)::int as lines,
				       round(100.0 * count(*) / sum(count(*)) over (), 1)::float8 as pct
				from nl.open_line_projection
				group by status`
		);
		const pct = (status: string) => mix.find((m) => m.status === status)?.pct ?? 0;

		const bands: Record<string, [number, number]> = {
			on_time: [45, 62],
			late_waiting_supply: [12, 28],
			past_due: [8, 18],
			no_supply: [6, 16],
			late_supply_overdue: [0, 6]
		};
		for (const [status, [low, high]] of Object.entries(bands)) {
			expect(pct(status), `${status} is ${pct(status)}%`).toBeGreaterThanOrEqual(low);
			expect(pct(status), `${status} is ${pct(status)}%`).toBeLessThanOrEqual(high);
		}
		// Every status is accounted for: the five above are all there are.
		expect(mix.map((m) => m.status).sort()).toEqual(Object.keys(bands).sort());

		// The demo story is "this line waits on that order", so a late line
		// should usually name one.
		const [named] = await db.asUser(DANA, (tx) =>
			tx.sql<{ lines: number; named: number; late: number; late_named: number }>`
				select count(*)::int as lines,
				       count(*) filter (where supply_document is not null)::int as named,
				       count(*) filter (where days_late > 0)::int as late,
				       count(*) filter (where days_late > 0 and supply_document is not null)::int as late_named
				from nl.open_line_projection`
		);
		expect(named.named / named.lines).toBeGreaterThan(0.4);
		expect(named.late_named / named.late).toBeGreaterThan(0.45);
	});

	it('keeps the supply it generates in step with the item master', async () => {
		// Today's purchase lines add up, part by part, to what the item master
		// says is on purchase order, and the same for production orders. The
		// live tables hold yesterday's file, which is close but not the same:
		// a line was received today and another was placed today.
		const [exact] = await db.asSystem((tx) =>
			tx.sql<{ purchase_off: number; production_off: number }>`
				select (select count(*)
				        from nl.stock s
				        left join (select item_no, sum(quantity) as q
				                   from nl.sample_open_purchase_lines(nl.today()) group by 1) p
				          on p.item_no = s.item_no
				        where s.on_purchase_order > 0 and coalesce(p.q, 0) <> s.on_purchase_order) as purchase_off,
				       (select count(*)
				        from nl.stock s
				        left join (select item_no, sum(quantity) as q
				                   from nl.sample_open_production_orders(nl.today()) group by 1) m
				          on m.item_no = s.item_no
				        where s.on_production_order > 0 and coalesce(m.q, 0) <> s.on_production_order) as production_off`
		);
		expect(exact).toEqual({ purchase_off: 0, production_off: 0 });

		const [live] = await db.asSystem((tx) =>
			tx.sql<{ live_qty: number; master_qty: number }>`
				select (select coalesce(sum(quantity), 0) from nl.open_purchase_lines) as live_qty,
				       (select coalesce(sum(on_purchase_order), 0) from nl.stock) as master_qty`
		);
		expect(live.live_qty).toBeGreaterThan(live.master_qty * 0.8);
		expect(live.live_qty).toBeLessThan(live.master_qty * 1.2);
	});

	it('fingerprints yesterday the same way the reader does, so the sample is recognized', async () => {
		const pairs: [SampleKind, string][] = [
			['yesterday', 'open_sales_lines'],
			['purchase-yesterday', 'open_purchase_lines'],
			['production-yesterday', 'open_production_orders']
		];
		for (const [kind, reportKind] of pairs) {
			const file = await db.asUser(PRIYA, (tx) => sampleFile(tx, kind));
			const read = readReport(file.fileName, file.text);
			expect(read.ok, kind).toBe(true);
			if (!read.ok) continue;
			expect(read.file.kind).toBe(reportKind);

			const [snapshot] = await db.asSystem((tx) =>
				tx.sql<{ content_hash: string; file_name: string }>`
					select content_hash, file_name from nl.export_snapshots
					where kind = ${reportKind} and (staged_at at time zone 'America/Chicago')::date = nl.today() - 1`
			);
			expect(snapshot.file_name, kind).toBe(file.fileName);
			// The seed stored the fingerprint the reader computes in JavaScript,
			// so uploading the file says "already loaded" instead of loading it twice.
			expect(snapshot.content_hash, kind).toBe(read.file.hash);

			const outcome = await uploadExport(db, PRIYA, { name: file.fileName, text: file.text }, crypto.randomUUID());
			expect(outcome.kind, kind).toBe('duplicate');
		}
	});

	it("loads today's three files as a normal day's change", async () => {
		for (const kind of ['today', 'purchase-today', 'production-today'] as SampleKind[]) {
			const file = await db.asUser(PRIYA, (tx) => sampleFile(tx, kind));
			const outcome = await uploadExport(db, PRIYA, { name: file.fileName, text: file.text }, crypto.randomUUID());
			expect(outcome.kind, kind).toBe('staged');
			if (outcome.kind !== 'staged') continue;
			expect(outcome.status, kind).toBe('staged');

			const review = await getSnapshotReview(db, PRIYA, outcome.snapshotId);
			expect(review!.errorCount, kind).toBe(0);
			// A day later: most rows the same, a few new, a few gone.
			expect(review!.diff.unchanged, kind).toBeGreaterThan(review!.lineCount / 2);
			expect(review!.diff.added + review!.diff.removed + review!.diff.changed, kind).toBeGreaterThan(0);

			const applied = await decideExport(db, PRIYA, {
				snapshotId: outcome.snapshotId,
				decision: 'apply',
				note: '',
				expectedUpdatedAt: review!.updatedAt,
				requestId: crypto.randomUUID()
			});
			expect(applied.summary, kind).not.toBeNull();
		}

		// With three fresh exports applied, the day-over-day views have both
		// sides for every report.
		const changes = await db.asUser(DANA, (tx) =>
			tx.sql<{ kind: string; change: string; n: number }>`
				select kind, change, count(*)::int as n from nl.supply_changes group by 1, 2`
		);
		expect(changes.length).toBeGreaterThan(0);
		expect(changes.some((c) => c.change === 'received')).toBe(true);
	});

	it('writes no em dash and no word from the name list into the world', async () => {
		// The name list itself lives outside the repository, so this checks the
		// one ordinary English word the generator might have reached for and
		// must not (it says "expedite" instead). The word is built from its
		// letters here so this file does not contain it either.
		const avoid = ['r', 'u', 's', 'h'].join('');
		const [check] = await db.asSystem((tx) =>
			tx.sql<{ dashes: number; avoided: number }>`
				select (select count(*) from nl.export_snapshot_lines
				        where description like '%' || chr(8212) || '%' or description like '%' || chr(8211) || '%')
				       + (select count(*) from nl.export_snapshots
				          where file_name like '%' || chr(8212) || '%') as dashes,
				       (select count(*) from nl.export_snapshot_lines
				        where description ~* ('(^|[^a-z])' || ${avoid} || '([^a-z]|$)')) as avoided`
		);
		expect(check).toEqual({ dashes: 0, avoided: 0 });
	});
});

describe('the forecast the page reads', () => {
	it('has headline numbers, late lines with reasons, and call sheets', async () => {
		const forecast = await getForecast(db, DANA, readFilters(new URL('http://x/operations/forecast')), DANA);

		expect(forecast.today).toBe(TODAY);
		expect(forecast.totals.openLines).toBeGreaterThan(80);
		expect(forecast.totals.openValue).toBeGreaterThan(0);
		expect(forecast.totals.lateLines).toBeGreaterThan(0);
		expect(forecast.totals.noSupplyLines).toBeGreaterThan(0);
		expect(forecast.sources).toHaveLength(3);

		// The default filter is "late, any reason", so every listed line is late.
		expect(forecast.lines.length).toBeGreaterThan(0);
		expect(forecast.lines.every((l) => l.daysLate > 0)).toBe(true);
		expect(forecast.lines.every((l) => l.projectedDate >= l.shipDate)).toBe(true);

		// A line waiting on a purchase order names it, its vendor and its date.
		const waiting = forecast.lines.find((l) => l.supplySource === 'purchase');
		if (waiting) {
			expect(waiting.supplyDocument).toMatch(/^PO-/);
			expect(waiting.supplyVendorName).toBeTruthy();
			expect(waiting.supplyDueDate).toBeTruthy();
		}

		expect(forecast.vendors.length).toBeGreaterThan(0);
		expect(forecast.vendors[0].valueWaiting).toBeGreaterThan(0);
		expect(forecast.customers.length).toBeGreaterThan(0);
		// Two applied sales exports, so a pushed ship date shows up as a move.
		expect(forecast.promiseMoves.length).toBeGreaterThan(0);
		expect(forecast.supplyMoves.length).toBeGreaterThan(0);
	});

	it('filters by status, vendor and owner', async () => {
		const all = await getForecast(db, DANA, readFilters(new URL('http://x/f?status=all')), DANA);
		const late = await getForecast(db, DANA, readFilters(new URL('http://x/f?status=late')), DANA);
		const none = await getForecast(db, DANA, readFilters(new URL('http://x/f?status=no_supply')), DANA);
		expect(all.lineCount).toBeGreaterThan(late.lineCount);
		expect(none.lines.every((l) => l.status === 'no_supply')).toBe(true);

		const vendorNo = late.options.vendors[0]?.value;
		if (vendorNo) {
			const one = await getForecast(db, DANA, readFilters(new URL(`http://x/f?vendor=${vendorNo}`)), DANA);
			expect(one.lines.length).toBeGreaterThan(0);
			expect(one.lines.every((l) => l.supplyVendorNo === vendorNo)).toBe(true);
		}

		// "Mine" is the accounts this user owns, so it cannot be more than all.
		const mine = await getForecast(db, DANA, readFilters(new URL('http://x/f?who=mine')), DANA);
		expect(mine.lineCount).toBeLessThanOrEqual(late.lineCount);
	});
});

describe('the automation trigger', () => {
	it('finds lines the forecast says will ship late', async () => {
		const rule: Rule = {
			name: 'Warn the owner about lines projected late',
			description: 'A line worth $250 or more is projected at least five days late.',
			trigger: 'order_line_projected_late',
			conditions: [
				{ field: 'days_late', op: 'gte', value: 5 },
				{ field: 'line_value', op: 'gte', value: 250 }
			],
			action: {
				kind: 'next_step',
				title: 'Tell {customer} about {headline}: {days_late} days late, {line_value} at stake',
				dueInDays: 1,
				assignTo: 'record_owner'
			},
			enabled: false
		};

		const result = await testRule(db, ADMIN, rule);
		expect(result.total).toBeGreaterThan(0);
		expect(result.matches.length).toBeGreaterThan(0);
		// The subject carries the projected date, so a new slip fires again.
		expect(result.matches[0].subjectKey).toMatch(/^projected:.+:\d+:\d{4}-\d{2}-\d{2}$/);
		expect(result.matches[0].text).toMatch(/days late/);
		expect(result.fields).toContain('days_late');

		// A rule that only wants lines with nothing on order gets fewer.
		const noSupply = await testRule(db, ADMIN, {
			...rule,
			conditions: [...rule.conditions, { field: 'no_supply', op: 'eq', value: 1 }]
		});
		expect(noSupply.total).toBeGreaterThan(0);
		expect(noSupply.total).toBeLessThanOrEqual(result.total);
	});
});
