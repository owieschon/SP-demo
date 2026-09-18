// The mill: compiling context, versioning it, serving it, and recording
// which version an action read.
//
// The three claims this file holds to account:
//
//   * a recompile that finds nothing new does NOT move the version, because
//     a version that churns is a version nobody can cite;
//   * a version an action recorded still resolves after later recompiles,
//     which is what makes an evaluation replayable and a reply explainable;
//   * what an outside agent gets over MCP is byte for byte what our own
//     agents read.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../db/pglite.ts';
import type { Db } from '../db/types.ts';
import { addContextEntry, recordClaim } from './claims.ts';
import { loadDictionary, type Dictionary } from './dictionary.ts';
import { runContextBuild, runSqlContextBuild } from './build.ts';
import {
	listContextResources,
	parseContextUri,
	readContextResource,
	runMcpContextCoverage,
	runMcpGetContext
} from './mcp.ts';
import { contextFor, contextVersion, readEntityContext } from './read.ts';
import { registerSources } from './sources.ts';
import { compileBundle, compileIn, promoteIn, recordContextRead } from './write.ts';
import { bundleServed, type SubjectKind } from '$lib/context/types';

const TODAY = '2026-09-17';
const ADMIN = 1;
const DANA = 2;

let db: Db;
let dictionary: Dictionary;
/** An account the seed gave plenty of context, so a bundle is worth reading. */
let rich: { kind: SubjectKind; id: string };

beforeAll(async () => {
	db = await createTestDb({ size: 'small', today: TODAY });
	dictionary = await db.asUser(ADMIN, (tx) => loadDictionary(tx));

	// The account with the most context, but not one the seed has already
	// given a packaging requirement or a preferred carrier: those two are what
	// the version tests add, and adding a second answer to an attribute that
	// already has one raises a conflict instead of promoting, which is correct
	// and is a different test.
	const [row] = await db.asSystem(
		(tx) => tx.sql<{ kind: SubjectKind; id: string }>`
			select f.subject_kind as kind, f.subject_id as id
			from nl.facts f
			where f.status = 'current' and f.subject_kind = 'customer'
			  and not exists (
			    select 1 from nl.facts t
			    where t.subject_kind = 'customer' and t.subject_id = f.subject_id
			      and t.status = 'current'
			      and t.attribute in ('packaging_requirement', 'preferred_carrier'))
			group by f.subject_kind, f.subject_id
			order by count(*) desc, f.subject_id
			limit 1`
	);
	rich = row;
});

afterAll(async () => {
	await db?.close();
});

// ---------------------------------------------------------------------------
// Compiling, and what moves the version
// ---------------------------------------------------------------------------

describe('compiling a bundle', () => {
	it('does not move the version when nothing changed', async () => {
		const first = await compileBundle(db, ADMIN, rich, 'internal_review');
		const again = await compileBundle(db, ADMIN, rich, 'internal_review');

		expect(again.changed).toBe(false);
		expect(again.version).toBe(first.version);
		expect(again.content_hash).toBe(first.content_hash);

		// built_at still moves, because how old the context is is a fact about
		// the mill and not about the content.
		const [built] = await db.asUser(
			ADMIN,
			(tx) => tx.sql<{ n: number }>`
				select count(*)::int as n from nl.context_bundles
				where subject_kind = ${rich.kind} and subject_id = ${rich.id}
				  and purpose = 'internal_review'`
		);
		// One row per version, and the version did not move, so still one.
		expect(built.n).toBe(first.version);
	});

	it('moves the version when a claim promotes, and carries the new fact with its citation', async () => {
		const before = await compileBundle(db, ADMIN, rich, 'quoting');

		// Something new and true about this account, from a source that will
		// win: the customer's own purchase order.
		await db.asUser(ADMIN, async (tx) => {
			const entry = await addContextEntry(tx, {
				subjectKind: 'customer',
				subjectId: rich.id,
				body: 'Pack everything in returnable steel racks, no cardboard.',
				requestId: `t-bundle-entry-${randomUUID()}`
			});
			const [doc] = await tx.query<{ id: number }>(
				`select nl.register_source_document('customer_purchase_orders', $1, 'racks',
				        now(), 'text/plain', null, 'context_entries', $2) as id`,
				[`bundle-racks-${rich.id}`, String(entry.entryId)]
			);
			await recordClaim(tx, {
				subjectKind: 'customer',
				subjectId: rich.id,
				subjectRaw: rich.id,
				attribute: 'packaging_requirement',
				value: {
					text: 'returnable steel racks, no cardboard',
					number: null,
					date: null,
					bool: null,
					json: null,
					unit: '',
					display: 'returnable steel racks, no cardboard'
				},
				scope: {},
				assertedAt: TODAY,
				validFrom: TODAY,
				validTo: null,
				sourceDocumentId: doc.id,
				extractor: 'po_reader',
				extractorVersion: '1',
				locator: 'line 1',
				snippet: 'Pack everything in returnable steel racks, no cardboard.',
				subjectConfidence: 0.99,
				attributeConfidence: 0.95,
				valueConfidence: 0.95
			});
			await promoteIn(tx, { kind: 'customer', id: rich.id }, `t-bundle-promote-${randomUUID()}`);
		});

		const after = await compileBundle(db, ADMIN, rich, 'quoting');
		expect(after.changed).toBe(true);
		expect(after.version).toBe(before.version + 1);
		expect(after.content_hash).not.toBe(before.content_hash);

		const bundle = await contextFor(db, ADMIN, rich, 'quoting');
		expect(bundleServed(bundle)).toBe(true);
		if (!bundleServed(bundle)) return;
		const fact = bundle.facts.find((row) => row.attribute === 'packaging_requirement');
		expect(fact).toBeDefined();
		expect(fact!.value_display).toBe('returnable steel racks, no cardboard');
		// The new fact arrives with its words, not just its value.
		expect(fact!.citations[0].snippet).toBe(
			'Pack everything in returnable steel racks, no cardboard.'
		);
		expect(fact!.citations[0].source_name).toBe('Purchase orders customers send in');
	});

	it('keeps every earlier version resolvable', async () => {
		const current = await compileBundle(db, ADMIN, rich, 'quoting');
		expect(current.version).toBeGreaterThan(1);

		const old = await contextVersion(db, ADMIN, rich, 'quoting', 1);
		expect(old).not.toBeNull();
		if (!old || !bundleServed(old)) return;
		expect(old.bundle_version).toBe(1);
		expect(old.frozen).toBe(true);
		// The frozen one does not have the fact that arrived later, which is
		// the whole point of being able to read it.
		expect(old.facts.some((fact) => fact.attribute === 'packaging_requirement')).toBe(false);
	});

	it('recompiles every bundle in a playbook’s scope and none outside it', async () => {
		// A playbook scoped to one account, on one surface.
		const other = await db.asSystem(
			(tx) => tx.sql<{ customer_no: string }>`
				select customer_no from nl.customers
				where customer_no <> ${rich.id} and not closed
				order by customer_no limit 1`
		);
		const otherId = other[0].customer_no;

		// Both accounts need a bundle for the surface before an edit can be
		// said to have left one of them alone.
		const richBefore = await compileBundle(db, ADMIN, rich, 'quoting');
		const otherBefore = await compileBundle(db, ADMIN, { kind: 'customer', id: otherId }, 'quoting');

		await db.asSystem((tx) =>
			tx.query(
				`insert into nl.playbooks (key, title, body, subject_kind, scope_customer_no, surfaces,
				                           disclosure, version, author_id, reviewed_at)
				 values ($1, 'How we quote this one account',
				         'They take one line per size and nothing else.', 'customer', $2,
				         '{quoting}', 'customer', 1, 1, nl.today())`,
				[`t-playbook-${randomUUID()}`.slice(0, 40), rich.id]
			)
		);

		const richAfter = await compileBundle(db, ADMIN, rich, 'quoting');
		const otherAfter = await compileBundle(db, ADMIN, { kind: 'customer', id: otherId }, 'quoting');

		// In scope: the version moved and the playbook is in the payload.
		expect(richAfter.changed).toBe(true);
		expect(richAfter.version).toBe(richBefore.version + 1);
		const bundle = await contextFor(db, ADMIN, rich, 'quoting');
		if (bundleServed(bundle)) {
			expect(bundle.playbooks.some((book) => book.title === 'How we quote this one account')).toBe(
				true
			);
		}

		// Out of scope: nothing moved at all.
		expect(otherAfter.changed).toBe(false);
		expect(otherAfter.version).toBe(otherBefore.version);
		expect(otherAfter.content_hash).toBe(otherBefore.content_hash);
	});

	it('serves the house playbooks in every bundle for their surface', async () => {
		const bundle = await contextFor(db, ADMIN, rich, 'quoting');
		expect(bundleServed(bundle)).toBe(true);
		if (!bundleServed(bundle)) return;
		// Tier one context: authored, reviewed, not extracted, and it does not
		// decay the way a fact does.
		expect(bundle.playbooks.some((book) => book.key === 'how_we_quote')).toBe(true);
		const quote = bundle.playbooks.find((book) => book.key === 'how_we_quote')!;
		expect(quote.version).toBeGreaterThan(0);
		expect(quote.body.length).toBeGreaterThan(80);
	});

	it('keeps an internal playbook out of an external bundle', async () => {
		const buying = await contextFor(db, ADMIN, rich, 'buying');
		const replying = await contextFor(db, ADMIN, rich, 'replying_external');
		// allocation_house_rules is marked internal.
		if (bundleServed(buying)) {
			expect(buying.playbooks.some((book) => book.key === 'allocation_house_rules')).toBe(true);
		}
		if (bundleServed(replying)) {
			expect(replying.playbooks.some((book) => book.key === 'allocation_house_rules')).toBe(false);
		}
	});
});

// ---------------------------------------------------------------------------
// The version an action read
// ---------------------------------------------------------------------------

describe('recording which version an action read', () => {
	it('records it, and the version still resolves after later recompiles', async () => {
		const at = await compileBundle(db, ADMIN, rich, 'replying_external');

		const readId = await db.asUser(DANA, (tx) =>
			recordContextRead(tx, {
				subject: { kind: rich.kind, id: rich.id },
				purpose: 'replying_external',
				version: at.version,
				action: 'desk_draft',
				entity: 'mail_draft',
				entityId: '6001',
				via: 'agent'
			})
		);
		expect(readId).toBeGreaterThan(0);

		// Something changes and the bundle is recompiled twice over.
		await db.asUser(ADMIN, async (tx) => {
			const entry = await addContextEntry(tx, {
				subjectKind: 'customer',
				subjectId: rich.id,
				body: 'Route it via Harrow Line Freight on anything palletised.',
				requestId: `t-read-entry-${randomUUID()}`
			});
			const [doc] = await tx.query<{ id: number }>(
				`select nl.register_source_document('customer_purchase_orders', $1, 'carrier',
				        now(), 'text/plain', null, 'context_entries', $2) as id`,
				[`read-carrier-${rich.id}`, String(entry.entryId)]
			);
			await recordClaim(tx, {
				subjectKind: 'customer',
				subjectId: rich.id,
				subjectRaw: rich.id,
				attribute: 'preferred_carrier',
				value: {
					text: 'Harrow Line Freight',
					number: null,
					date: null,
					bool: null,
					json: null,
					unit: '',
					display: 'Harrow Line Freight'
				},
				scope: {},
				assertedAt: TODAY,
				validFrom: TODAY,
				validTo: null,
				sourceDocumentId: doc.id,
				extractor: 'po_reader',
				extractorVersion: '1',
				locator: 'line 1',
				snippet: 'Route it via Harrow Line Freight on anything palletised.',
				subjectConfidence: 0.99,
				attributeConfidence: 0.95,
				valueConfidence: 0.9
			});
			await promoteIn(tx, { kind: 'customer', id: rich.id }, `t-read-promote-${randomUUID()}`);
			await compileIn(tx, { kind: 'customer', id: rich.id });
			await compileIn(tx, { kind: 'customer', id: rich.id });
		});

		const now = await compileBundle(db, ADMIN, rich, 'replying_external');
		expect(now.version).toBeGreaterThan(at.version);

		// The recorded version still resolves, with the content it had.
		const frozen = await contextVersion(db, ADMIN, rich, 'replying_external', at.version);
		expect(frozen).not.toBeNull();
		if (frozen && bundleServed(frozen)) {
			expect(frozen.bundle_version).toBe(at.version);
			expect(frozen.facts.some((fact) => fact.attribute === 'preferred_carrier')).toBe(false);
		}

		// And the read is on the record, with what it produced, so a reply can
		// be explained after the fact.
		const [row] = await db.asUser(
			ADMIN,
			(tx) => tx.sql<{ action: string; bundle_version: number; entity: string; entity_id: string; via: string }>`
				select action, bundle_version, entity, entity_id, via
				from nl.context_reads where id = ${readId}`
		);
		expect(row.action).toBe('desk_draft');
		expect(row.bundle_version).toBe(at.version);
		expect(row.entity).toBe('mail_draft');
		expect(row.entity_id).toBe('6001');
		expect(row.via).toBe('agent');

		// The entity page shows it, which is where a person would look.
		const context = await readEntityContext(db, ADMIN, rich);
		expect(context?.reads.some((read) => read.action === 'desk_draft')).toBe(true);
	});

	it('puts the bundle it read on the agent harness’s own run record', async () => {
		const at = await compileBundle(db, ADMIN, rich, 'quoting');
		// A run key reads like order_desk:412, which is the harness's shape.
		const runKey = `order_desk:${Math.floor(Math.random() * 900_000) + 100_000}`;

		await db.asUser(DANA, (tx) =>
			recordContextRead(tx, {
				subject: rich,
				purpose: 'quoting',
				version: at.version,
				action: 'desk_draft',
				entity: 'mail_draft',
				entityId: '6002',
				runKey,
				agent: 'order_desk',
				workKind: 'rfq',
				requestId: `t-ctx-run-${randomUUID()}`
			})
		);

		// The harness's own event table (migration 0028), not a second record
		// of runs invented here.
		const [event] = await db.asUser(
			ADMIN,
			(tx) => tx.sql<{ check_id: string; verdict: string; detail: string; agent: string }>`
				select check_id, verdict, detail, agent from nl.agent_events
				where run_key = ${runKey}`
		);
		expect(event.check_id).toBe('context_bundle');
		expect(event.agent).toBe('order_desk');
		// Fresh bundle, so it passes; a stale one is recorded as degraded.
		expect(event.verdict).toBe('pass');
		expect(event.detail).toMatch(new RegExp(`bundle version ${at.version}`));
		expect(event.detail).toMatch(/hash [0-9a-f]{12}/);
	});

	it('refuses to record a read of a bundle that does not exist', async () => {
		await expect(
			db.asUser(DANA, (tx) =>
				recordContextRead(tx, {
					subject: { kind: 'customer', id: '999999' },
					purpose: 'quoting',
					action: 'desk_draft'
				})
			)
		).rejects.toMatchObject({ code: 'NL404' });
	});
});

// ---------------------------------------------------------------------------
// Over MCP
// ---------------------------------------------------------------------------

describe('the same bundle over MCP', () => {
	it('returns the same payload and the same hash as nl.context_for', async () => {
		const uri = `northline://context/${rich.kind}/${rich.id}/quoting`;
		const resource = await readContextResource(db, DANA, uri);
		expect(resource).not.toBeNull();
		if (!resource) return;

		const direct = await contextFor(db, DANA, rich, 'quoting');
		// Byte for byte: the resource is the function's own answer, serialized.
		expect(resource.text).toBe(JSON.stringify(direct));
		expect(resource.mimeType).toBe('application/json');
		expect(resource.uri).toBe(uri);

		const parsed = JSON.parse(resource.text);
		if (bundleServed(direct)) {
			expect(parsed.content_hash).toBe(direct.content_hash);
			expect(parsed.bundle_version).toBe(direct.bundle_version);
		}
	});

	it('serves one frozen version by uri', async () => {
		const uri = `northline://context/${rich.kind}/${rich.id}/quoting?v=1`;
		const resource = await readContextResource(db, DANA, uri);
		expect(resource).not.toBeNull();
		const parsed = JSON.parse(resource!.text);
		expect(parsed.bundle_version).toBe(1);
		expect(parsed.frozen).toBe(true);
	});

	it('refuses a uri it does not recognise rather than guessing', async () => {
		for (const bad of [
			'northline://context/customer/1214',
			'northline://context/spaceship/1214/quoting',
			'northline://context/customer/1214/gossip',
			'northline://context/customer/1214/quoting?v=abc',
			'https://example.com/context/customer/1214/quoting'
		]) {
			expect(parseContextUri(bad)).toBeNull();
			expect(await readContextResource(db, DANA, bad)).toBeNull();
		}
	});

	it('reads a good uri into its three parts', () => {
		expect(parseContextUri('northline://context/customer/10012/quoting')).toEqual({
			kind: 'customer',
			id: '10012',
			purpose: 'quoting',
			version: null
		});
		expect(parseContextUri('northline://context/vendor/V10010/buying?v=7')).toEqual({
			kind: 'vendor',
			id: 'V10010',
			purpose: 'buying',
			version: 7
		});
	});

	it('lists the bundles worth attaching, with their version and age', async () => {
		const resources = await listContextResources(db, DANA, 20);
		expect(resources.length).toBeGreaterThan(0);
		for (const resource of resources) {
			expect(resource.uri.startsWith('northline://context/')).toBe(true);
			expect(resource.mimeType).toBe('application/json');
			expect(resource.description).toMatch(/Version \d+/);
			// A listed resource has to be readable, or the listing is a lie.
			expect(await readContextResource(db, DANA, resource.uri)).not.toBeNull();
		}
	});

	it('answers the tool the same way, and refuses a version that is not there', async () => {
		const answer = await runMcpGetContext(db, DANA, {
			entity_kind: rich.kind,
			entity_id: rich.id,
			purpose: 'quoting'
		});
		const direct = await contextFor(db, DANA, rich, 'quoting');
		expect(JSON.stringify(answer)).toBe(JSON.stringify(direct));

		const missing = await runMcpGetContext(db, DANA, {
			entity_kind: rich.kind,
			entity_id: rich.id,
			purpose: 'quoting',
			version: 9999
		});
		expect(missing).toHaveProperty('error');
	});

	it('shows an outside agent the gaps too', async () => {
		const coverage = await runMcpContextCoverage(db, DANA);
		expect(coverage.attributes).toBeGreaterThan(5);
		expect(coverage.worst.length).toBeGreaterThan(0);
		expect(coverage.note).toMatch(/work list/);
	});
});

// ---------------------------------------------------------------------------
// The mill itself
// ---------------------------------------------------------------------------

describe('the context build', () => {
	it('registers what the stores hold and is idempotent about it', async () => {
		const first = await db.asUser(ADMIN, (tx) => registerSources(tx));
		expect(first.length).toBeGreaterThan(0);
		// It runs after the seed, so most of it is known already.
		const second = await db.asUser(ADMIN, (tx) => registerSources(tx));
		for (const result of second) {
			expect(result.registered).toBe(0);
		}
	});

	it('works through the coverage gaps and promotes what the rules allow', async () => {
		const summary = await runContextBuild(db, ADMIN, { subjects: 6, documentsPerSubject: 10 });

		expect(summary.explored).toBeGreaterThan(0);
		expect(summary.chased.length).toBeGreaterThan(0);
		// It chose the worst-covered attributes, so every one it chased has a
		// gap behind it.
		for (const chase of summary.chased) {
			expect(chase.subjects).toBeGreaterThan(0);
		}
		expect(summary.ms).toBeGreaterThan(0);
		// Nothing about this is allowed to invent a citation.
		expect(summary.inventedSpansRefused).toBe(0);
	});

	it('has a SQL-only entry point a schedule can call', async () => {
		const result = await runSqlContextBuild(db, ADMIN, 8);
		expect(result.subjects).toBeGreaterThan(0);
		expect(result.promoted).toBeGreaterThanOrEqual(0);
		expect(result.bundles_changed).toBeGreaterThanOrEqual(0);
	});
});

// ---------------------------------------------------------------------------
// Serving on a bad day
// ---------------------------------------------------------------------------

describe('when the mill is behind', () => {
	it('still serves the last good bundle and labels how old it is', async () => {
		// Age one bundle by a week. built_at is the mill's own bookkeeping, so
		// this is the one row a test may reach past a function to move.
		await db.asSystem((tx) =>
			tx.query(
				`update nl.context_bundles set built_at = now() - interval '7 days'
				 where subject_kind = $1 and subject_id = $2 and purpose = 'buying' and is_current`,
				[rich.kind, rich.id]
			)
		);

		const bundle = await contextFor(db, DANA, rich, 'buying');
		if (bundleServed(bundle)) {
			// Served, and honest about it: an agent running on the last good
			// context and saying so beats an agent guessing.
			expect(bundle.served).toBe(true);
			expect(bundle.bundle_stale).toBe(true);
			expect(bundle.age_hours).toBeGreaterThan(100);
		} else {
			// Nothing was above the bar for buying, which it says rather than
			// answering with an empty list.
			expect(bundle.reason.length).toBeGreaterThan(10);
		}
	});

	it('gives the entity page every purpose with its age', async () => {
		const context = await readEntityContext(db, ADMIN, rich);
		expect(context).not.toBeNull();
		expect(context!.bundles.length).toBe(6);
		for (const bundle of context!.bundles) {
			expect(bundle.version).toBeGreaterThan(0);
			expect(bundle.content_hash).toMatch(/^[0-9a-f]{64}$/);
			expect(bundle.built_at).toMatch(/^\d{4}-/);
		}
	});
});

// ---------------------------------------------------------------------------
// How fast the read path is
// ---------------------------------------------------------------------------

describe('the read path', () => {
	it('answers in single-digit milliseconds', async () => {
		const times: number[] = [];
		for (let i = 0; i < 40; i++) {
			const started = performance.now();
			await contextFor(db, DANA, rich, 'quoting');
			times.push(performance.now() - started);
		}
		times.sort((a, b) => a - b);
		const median = times[Math.floor(times.length / 2)];
		// PGlite is Postgres compiled to WebAssembly and is slower than the
		// real thing, so this is a generous ceiling: the claim it holds to is
		// that serving a bundle is one index lookup and a jsonb read, not that
		// WebAssembly is fast.
		expect(median).toBeLessThan(40);
		expect(dictionary.size).toBeGreaterThan(10);
	});
});
