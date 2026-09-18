// The rules: claims in, one fact out, and what happens when the rules will
// not settle it.
//
// Every fixture here is written through nl.record_claim, because that is
// where the rules are and a fixture that goes round them proves nothing. The
// world is the seeded one, so the accounts, parts and mail are real rows.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../db/pglite.ts';
import type { Db, Tx } from '../db/types.ts';
import { AppError, toAppError } from '../errors.ts';
import { addContextEntry, recordClaim } from './claims.ts';
import { loadDictionary, type Dictionary } from './dictionary.ts';
import { exploreSources } from './explore.ts';
import { contextFor, contextValue, readConflicts, readCoverage, readReviewItems } from './read.ts';
import { resolveDocumentSubject } from './resolve.ts';
import { compileIn, promoteClaims, promoteIn, resolveConflict, revokeExtractor } from './write.ts';
import type { ProposedClaim, SubjectKind } from '$lib/context/types';
import { bundleServed } from '$lib/context/types';

const TODAY = '2026-09-17';
const ADMIN = 1; // Elena Brooks
const DANA = 2; // an account manager

let db: Db;
let dictionary: Dictionary;
/** An account with no seeded context, so each test starts from nothing. */
let clean: { customer_no: string; name: string };

/**
 * A source document with real text behind it, so the span guard has something
 * to check a snippet against. Each test makes its own, at the trust tier it
 * needs, which is how three sources disagreeing is set up.
 *
 * The text goes in through nl.add_context_entry, the real write function, and
 * then a second source document is registered over the same row under
 * whichever source key the test wants. Nobody is granted INSERT on any of
 * these tables, so a function is the only way in, which is the point of them.
 */
async function documentWith(
	tx: Tx,
	options: {
		sourceKey: string;
		ref: string;
		subjectKind?: SubjectKind;
		subjectId: string;
		text: string;
		receivedAt: string;
	}
): Promise<number> {
	const entry = await addContextEntry(tx, {
		subjectKind: options.subjectKind ?? 'customer',
		subjectId: options.subjectId,
		body: options.text,
		requestId: `t-entry-${randomUUID()}`
	});
	if (options.sourceKey === 'hand_entry') return entry.sourceDocumentId;
	const [row] = await tx.query<{ id: number }>(
		`select nl.register_source_document($1, $2, $3, $4::timestamptz, 'text/plain', null,
		        'context_entries', $5) as id`,
		[options.sourceKey, options.ref, options.ref, options.receivedAt, String(entry.entryId)]
	);
	return row.id;
}

/** An open account the seed made no claims about, so a test starts clean. */
async function freshAccount(tx: Tx): Promise<{ customer_no: string; name: string }> {
	const [row] = await tx.sql<{ customer_no: string; name: string }>`
		select c.customer_no, c.name from nl.customers c
		where not c.closed and not c.blocked
		  and not exists (select 1 from nl.claims cl
		                  where cl.subject_kind = 'customer' and cl.subject_id = c.customer_no)
		  and not exists (select 1 from nl.context_entries e
		                  where e.subject_kind = 'customer' and e.subject_id = c.customer_no)
		order by c.customer_no limit 1`;
	return row;
}

/** A claim, with the parts a test does not care about filled in. */
function claim(over: Partial<ProposedClaim> & Pick<ProposedClaim, 'attribute' | 'sourceDocumentId' | 'locator' | 'snippet'>): ProposedClaim {
	const attribute = dictionary.get(over.attribute)!;
	return {
		subjectKind: over.subjectKind ?? 'customer',
		subjectId: over.subjectId === undefined ? clean.customer_no : over.subjectId,
		subjectRaw: over.subjectRaw ?? clean.name,
		attribute: over.attribute,
		value:
			over.value ??
			({
				text: null,
				number: 45,
				date: null,
				bool: null,
				json: null,
				unit: attribute.unit,
				display: `45 ${attribute.unit}`
			}),
		scope: over.scope ?? {},
		assertedAt: over.assertedAt ?? TODAY,
		validFrom: over.validFrom ?? over.assertedAt ?? TODAY,
		validTo: over.validTo ?? null,
		sourceDocumentId: over.sourceDocumentId,
		extractor: over.extractor ?? 'recognizer',
		extractorVersion: over.extractorVersion ?? '1',
		locator: over.locator,
		snippet: over.snippet,
		subjectConfidence: over.subjectConfidence ?? 0.98,
		attributeConfidence: over.attributeConfidence ?? 0.95,
		valueConfidence: over.valueConfidence ?? 0.95
	};
}

function days(iso: string, delta: number): string {
	const date = new Date(`${iso}T00:00:00Z`);
	date.setUTCDate(date.getUTCDate() + delta);
	return date.toISOString().slice(0, 10);
}

/** A number as payment terms, with the display string the database derives. */
function terms(value: number) {
	return { text: null, number: value, date: null, bool: null, json: null, unit: 'days', display: `${value} days` };
}

beforeAll(async () => {
	db = await createTestDb({ size: 'small', today: TODAY });
	dictionary = await db.asUser(ADMIN, (tx) => loadDictionary(tx));

	// An open account the seed made no claims about, so these tests are not
	// arguing with the seeded world.
	const [row] = await db.asSystem(
		(tx) => tx.sql<{ customer_no: string; name: string }>`
			select c.customer_no, c.name
			from nl.customers c
			where not c.closed and not c.blocked
			  and not exists (select 1 from nl.claims cl
			                  where cl.subject_kind = 'customer' and cl.subject_id = c.customer_no)
			  and exists (select 1 from nl.invoice_lines il where il.customer_no = c.customer_no)
			order by c.customer_no
			limit 1`
	);
	clean = row;
});

afterAll(async () => {
	await db?.close();
});

// ---------------------------------------------------------------------------
// The promotion rule
// ---------------------------------------------------------------------------

describe('the promotion rule', () => {
	it('picks the highest trust tier when three sources disagree', async () => {
		const result = await db.asUser(ADMIN, async (tx) => {
			// Three sources, three answers, three different tiers. The legacy
			// export is oldest and least trusted; the purchase order is the
			// customer's own paperwork.
			const legacy = await documentWith(tx, {
				sourceKey: 'legacy_crm_2024',
				ref: `three-legacy-${clean.customer_no}`,
				subjectId: clean.customer_no,
				text: 'Terms on file: Net 30 from 2024.',
				receivedAt: '2024-03-14'
			});
			const mail = await documentWith(tx, {
				sourceKey: 'mail_archive',
				ref: `three-mail-${clean.customer_no}`,
				subjectId: clean.customer_no,
				text: 'For the record our terms with you are Net 45.',
				receivedAt: days(TODAY, -60)
			});
			const po = await documentWith(tx, {
				sourceKey: 'customer_purchase_orders',
				ref: `three-po-${clean.customer_no}`,
				subjectId: clean.customer_no,
				text: '1. Payment terms are Net 60 from the date of invoice.',
				receivedAt: days(TODAY, -90)
			});

			await recordClaim(
				tx,
				claim({
					attribute: 'payment_terms_days',
					value: terms(30),
					assertedAt: '2024-03-14',
					sourceDocumentId: legacy,
					locator: 'row 1',
					snippet: 'Terms on file: Net 30 from 2024.'
				})
			);
			await recordClaim(
				tx,
				claim({
					attribute: 'payment_terms_days',
					value: terms(45),
					assertedAt: days(TODAY, -60),
					sourceDocumentId: mail,
					locator: 'line 1',
					snippet: 'For the record our terms with you are Net 45.'
				})
			);
			await recordClaim(
				tx,
				claim({
					attribute: 'payment_terms_days',
					value: terms(60),
					// Older than the mail, and it still wins, because the tier
					// gap settles it before recency is looked at.
					assertedAt: days(TODAY, -90),
					sourceDocumentId: po,
					locator: 'page 2, line 3',
					snippet: '1. Payment terms are Net 60 from the date of invoice.'
				})
			);

			await promoteIn(tx, { kind: 'customer', id: clean.customer_no }, `t-three-${randomUUID()}`);
			return tx.sql<{ value_display: string; decided_rule: string; claim_ids: number[] }>`
				select value_display, decided_rule, claim_ids from nl.facts
				where subject_kind = 'customer' and subject_id = ${clean.customer_no}
				  and attribute = 'payment_terms_days' and status = 'current'`;
		});

		expect(result).toHaveLength(1);
		expect(result[0].value_display).toBe('60 days');
		// The rule says why, on the row, in words.
		expect(result[0].decided_rule).toMatch(/highest trust tier \(4\)/);
		// One claim supports it: the other two disagree, so they are not cited.
		expect(result[0].claim_ids).toHaveLength(1);
	});

	it('lets a high-trust source beat a newer low-trust one', async () => {
		const [fact] = await db.asUser(ADMIN, async (tx) => {
			const [account] = await tx.sql<{ customer_no: string; name: string }>`
				select customer_no, name from nl.customers
				where ships_own_carrier and not closed and not blocked
				order by customer_no limit 1`;

			const erp = await tx.query<{ id: number }>(
				`select nl.register_source_document('erp_customer_master', $1, $2,
				        $3::timestamptz, 'text/csv', null, 'customers', $4) as id`,
				[
					`newer-erp-${account.customer_no}`,
					'Customer master row',
					days(TODAY, -3),
					account.customer_no
				]
			);
			const hand = await documentWith(tx, {
				sourceKey: 'hand_entry',
				ref: `newer-hand-${account.customer_no}`,
				subjectId: account.customer_no,
				text: 'They said on the phone we pay the freight from now on.',
				receivedAt: `${TODAY}T12:00:00Z`
			});

			// The ERP row, three days old.
			await recordClaim(
				tx,
				claim({
					subjectId: account.customer_no,
					subjectRaw: account.name,
					attribute: 'freight_payer',
					value: {
						text: 'third_party',
						number: null,
						date: null,
						bool: null,
						json: null,
						unit: '',
						display: 'third party'
					},
					assertedAt: days(TODAY, -3),
					sourceDocumentId: erp[0].id,
					locator: 'column Ships Own Carrier',
					snippet: 'Ships Own Carrier = Yes'
				})
			);
			// A hand entry from today, disagreeing. Newer, and it loses.
			await recordClaim(
				tx,
				claim({
					subjectId: account.customer_no,
					subjectRaw: account.name,
					attribute: 'freight_payer',
					value: {
						text: 'customer',
						number: null,
						date: null,
						bool: null,
						json: null,
						unit: '',
						display: 'customer'
					},
					assertedAt: TODAY,
					sourceDocumentId: hand,
					locator: 'line 1',
					snippet: 'They said on the phone we pay the freight from now on.'
				})
			);

			await promoteIn(tx, { kind: 'customer', id: account.customer_no }, `t-newer-${randomUUID()}`);
			return tx.sql<{ value_display: string; decided_rule: string }>`
				select value_display, decided_rule from nl.facts
				where subject_kind = 'customer' and subject_id = ${account.customer_no}
				  and attribute = 'freight_payer' and status = 'current'`;
		});

		expect(fact.value_display).toBe('third party');
		expect(fact.decided_rule).toMatch(/highest trust tier \(5\)/);
	});

	it('sends a disagreement no source outranks to a person, and promotes nothing', async () => {
		const before = await db.asUser(ADMIN, (tx) =>
			tx.sql<{ n: number }>`select count(*)::int as n from nl.facts where status = 'current'`
		);

		const conflicts = await db.asUser(ADMIN, async (tx) => {
			const account = await freshAccount(tx);

			// Two sources at the SAME tier (mail and a hand entry are both 3),
			// saying 30 and 90. The gap is two thirds, well over the threshold.
			for (const [ref, value, snippet, source] of [
				['tie-mail', 90, 'Our standing terms with you are Net 90.', 'mail_archive'],
				['tie-hand', 30, 'Their controller told me their terms are Net 30.', 'hand_entry']
			] as const) {
				const doc = await documentWith(tx, {
					sourceKey: source,
					ref: `${ref}-${account.customer_no}`,
					subjectId: account.customer_no,
					text: snippet,
					receivedAt: `${days(TODAY, -20)}T09:00:00Z`
				});
				await recordClaim(
					tx,
					claim({
						subjectId: account.customer_no,
						subjectRaw: account.name,
						attribute: 'payment_terms_days',
						value: terms(value),
						assertedAt: days(TODAY, -20),
						sourceDocumentId: doc,
						locator: 'line 1',
						snippet
					})
				);
			}

			const result = await promoteIn(
				tx,
				{ kind: 'customer', id: account.customer_no, attribute: 'payment_terms_days' },
				`t-tie-${randomUUID()}`
			);
			expect(result.promoted).toBe(0);
			expect(result.conflicts_raised).toBe(1);

			return tx.sql<{ subject_id: string; disagreement: number; reason: string }>`
				select subject_id, disagreement, reason from nl.context_conflicts
				where subject_id = ${account.customer_no} and status = 'open'`;
		});

		expect(conflicts).toHaveLength(1);
		expect(Number(conflicts[0].disagreement)).toBeGreaterThan(0.34);
		expect(conflicts[0].reason).toMatch(/neither source outranks/);

		const after = await db.asUser(ADMIN, (tx) =>
			tx.sql<{ n: number }>`select count(*)::int as n from nl.facts where status = 'current'`
		);
		// Nothing was promoted for that account, so the total is unchanged.
		expect(after[0].n).toBe(before[0].n);
	});

	it('promotes a disagreement that is not material', async () => {
		const [fact] = await db.asUser(ADMIN, async (tx) => {
			const account = await freshAccount(tx);

			// 30 and 28 days: the same agreement, typed twice, a month apart.
			// The relative gap is under the threshold, so nobody is asked about
			// it, and the newer one wins on the rule's second rung.
			for (const [ref, value, snippet, age] of [
				['near-a', 30, 'Terms Net 30 as agreed.', -15],
				['near-b', 28, 'Terms Net 28, per the contract.', -45]
			] as const) {
				const doc = await documentWith(tx, {
					sourceKey: 'mail_archive',
					ref: `${ref}-${account.customer_no}`,
					subjectId: account.customer_no,
					text: snippet,
					receivedAt: `${days(TODAY, age)}T09:00:00Z`
				});
				await recordClaim(
					tx,
					claim({
						subjectId: account.customer_no,
						subjectRaw: account.name,
						attribute: 'payment_terms_days',
						value: terms(value),
						assertedAt: days(TODAY, age),
						sourceDocumentId: doc,
						locator: 'line 1',
						snippet
					})
				);
			}

			const result = await promoteIn(
				tx,
				{ kind: 'customer', id: account.customer_no, attribute: 'payment_terms_days' },
				`t-near-${randomUUID()}`
			);
			expect(result.conflicts_raised).toBe(0);
			expect(result.promoted).toBe(1);
			return tx.sql<{ value_display: string }>`
				select value_display from nl.facts
				where subject_id = ${account.customer_no} and attribute = 'payment_terms_days'
				  and status = 'current'`;
		});
		expect(fact.value_display).toBe('30 days');
	});

	it('stops counting a revoked extractor’s claims', async () => {
		const account = await db.asUser(ADMIN, async (tx) => {
			const row = await freshAccount(tx);

			// One claim from a good extractor and one, better trusted, from an
			// extractor that is about to be revoked. Both read the same entry,
			// registered twice at two trust tiers.
			const good = await documentWith(tx, {
				sourceKey: 'mail_archive',
				ref: `revoke-good-${row.customer_no}`,
				subjectId: row.customer_no,
				text: 'Terms are Net 45 on this account.\nPaperwork says Net 20, which is wrong.',
				receivedAt: `${days(TODAY, -5)}T09:00:00Z`
			});
			const [badRow] = await tx.query<{ id: number }>(
				`select nl.register_source_document('customer_purchase_orders', $1, 'bad', $2::timestamptz,
				        'text/plain', null, 'context_entries', d.ref_id) as id
				 from nl.source_documents d where d.id = $3`,
				[`revoke-bad-${row.customer_no}`, `${days(TODAY, -5)}T09:00:00Z`, good]
			);
			const bad = badRow.id;
			await recordClaim(
				tx,
				claim({
					subjectId: row.customer_no,
					subjectRaw: row.name,
					attribute: 'payment_terms_days',
					value: terms(45),
					assertedAt: days(TODAY, -5),
					sourceDocumentId: good,
					locator: 'line 1',
					snippet: 'Terms are Net 45 on this account.'
				})
			);
			await recordClaim(
				tx,
				claim({
					subjectId: row.customer_no,
					subjectRaw: row.name,
					attribute: 'payment_terms_days',
					value: terms(20),
					assertedAt: days(TODAY, -5),
					sourceDocumentId: bad,
					extractor: 'bad_reader',
					extractorVersion: '3',
					locator: 'page 2, line 1',
					snippet: 'Paperwork says Net 20, which is wrong.'
				})
			);
			return row;
		});

		// Before the revocation, the tier-4 claim from the bad extractor wins.
		await promoteClaims(db, ADMIN, { kind: 'customer', id: account.customer_no }, `t-rv1-${randomUUID()}`);
		const [before] = await db.asUser(
			ADMIN,
			(tx) => tx.sql<{ value_display: string }>`
				select value_display from nl.facts
				where subject_id = ${account.customer_no} and attribute = 'payment_terms_days'
				  and status = 'current'`
		);
		expect(before.value_display).toBe('20 days');

		await revokeExtractor(db, ADMIN, {
			name: 'bad_reader',
			version: '3',
			note: 'It read the wrong line of the terms block.',
			requestId: `t-revoke-${randomUUID()}`
		});

		// After, its claims are still on the record and no longer count.
		await promoteClaims(db, ADMIN, { kind: 'customer', id: account.customer_no }, `t-rv2-${randomUUID()}`);
		const [after] = await db.asUser(
			ADMIN,
			(tx) => tx.sql<{ value_display: string }>`
				select value_display from nl.facts
				where subject_id = ${account.customer_no} and attribute = 'payment_terms_days'
				  and status = 'current'`
		);
		expect(after.value_display).toBe('45 days');

		const [kept] = await db.asUser(
			ADMIN,
			(tx) => tx.sql<{ n: number }>`
				select count(*)::int as n from nl.claims
				where extractor = 'bad_reader' and extractor_version = '3'`
		);
		expect(kept.n).toBe(1);
	});

	it('is refused to somebody who is not an administrator', async () => {
		await expect(
			revokeExtractor(db, DANA, {
				name: 'recognizer',
				version: '1',
				note: 'no',
				requestId: `t-revoke-no-${randomUUID()}`
			})
		).rejects.toMatchObject({ code: 'NL403' });
	});
});

// ---------------------------------------------------------------------------
// A person's decision
// ---------------------------------------------------------------------------

describe('a person deciding between two claims', () => {
	it('beats the rule, is recorded as theirs, and the rule does not change it back', async () => {
		const [conflict] = await db.asUser(ADMIN, (tx) =>
			tx.sql<{ id: number; row_version: Date; winner_claim_id: number; rival_claim_id: number; subject_id: string; attribute: string }>`
				select id, updated_at as row_version, winner_claim_id, rival_claim_id, subject_id, attribute
				from nl.context_conflicts where status = 'open'
				order by id limit 1`
		);
		expect(conflict).toBeDefined();

		// Choose the RIVAL, which is the one the rule would not have picked.
		const rival = await db.asUser(
			ADMIN,
			(tx) => tx.sql<{ value_display: string }>`
				select value_display from nl.claims where id = ${conflict.rival_claim_id}`
		);

		const result = await resolveConflict(db, ADMIN, {
			conflictId: conflict.id,
			claimId: conflict.rival_claim_id,
			note: 'Their controller confirmed it on the phone.',
			rowVersion: conflict.row_version.toISOString(),
			requestId: `t-resolve-${randomUUID()}`
		});
		expect(result.decided_via).toBe('person');

		const [fact] = await db.asUser(
			ADMIN,
			(tx) => tx.sql<{ value_display: string; decided_via: string; decided_by: number; decided_rule: string }>`
				select value_display, decided_via, decided_by, decided_rule
				from nl.facts where id = ${result.fact_id}`
		);
		expect(fact.value_display).toBe(rival[0].value_display);
		expect(fact.decided_via).toBe('person');
		expect(fact.decided_by).toBe(ADMIN);

		// The rule runs again and leaves it alone.
		const again = await promoteClaims(
			db,
			ADMIN,
			{ kind: 'customer', id: conflict.subject_id, attribute: conflict.attribute },
			`t-again-${randomUUID()}`
		);
		expect(again.held_for_a_person).toBeGreaterThan(0);
		expect(again.promoted).toBe(0);

		const [still] = await db.asUser(
			ADMIN,
			(tx) => tx.sql<{ value_display: string; decided_via: string }>`
				select value_display, decided_via from nl.facts
				where subject_id = ${conflict.subject_id} and attribute = ${conflict.attribute}
				  and status = 'current'`
		);
		expect(still.value_display).toBe(rival[0].value_display);
		expect(still.decided_via).toBe('person');

		// And the decision is in the audit trail, with the note.
		const [audit] = await db.asUser(
			ADMIN,
			(tx) => tx.sql<{ actor_id: number; via: string; detail: { note: string } }>`
				select actor_id, via, detail from nl.audit_log
				where action = 'resolve_context_conflict' and entity_id = ${String(result.fact_id)}`
		);
		expect(audit.actor_id).toBe(ADMIN);
		expect(audit.via).toBe('ui');
		expect(audit.detail.note).toBe('Their controller confirmed it on the phone.');
	});

	it('refuses a conflict that moved since the page loaded', async () => {
		const [conflict] = await db.asUser(ADMIN, (tx) =>
			tx.sql<{ id: number; winner_claim_id: number }>`
				select id, winner_claim_id from nl.context_conflicts where status = 'open'
				order by id limit 1`
		);
		if (!conflict) return; // no open conflict left: nothing to prove here
		await expect(
			resolveConflict(db, ADMIN, {
				conflictId: conflict.id,
				claimId: conflict.winner_claim_id,
				note: '',
				rowVersion: '2020-01-01T00:00:00.000Z',
				requestId: `t-stale-${randomUUID()}`
			})
		).rejects.toMatchObject({ code: 'NL409' });
	});
});

// ---------------------------------------------------------------------------
// What a claim has to carry to be one
// ---------------------------------------------------------------------------

describe('what nl.record_claim refuses', () => {
	async function attempt(work: (tx: Tx) => Promise<unknown>): Promise<AppError> {
		try {
			await db.asUser(ADMIN, work);
		} catch (error) {
			const app = toAppError(error);
			if (app) return app;
			throw error;
		}
		throw new Error('that should have been refused');
	}

	it('refuses a claim with no citation', async () => {
		const error = await attempt(async (tx) => {
			const doc = await documentWith(tx, {
				sourceKey: 'hand_entry',
				ref: `nocite-${randomUUID()}`,
				subjectId: clean.customer_no,
				text: 'Terms are Net 45 here.',
				receivedAt: TODAY
			});
			await tx.query(
				`select nl.record_claim('customer', $1, $2, 'payment_terms_days',
				        null, 45, null, null, null, 'days', '45 days',
				        null, null, null, null, null, $3::date, $3::date, null,
				        $4, 'recognizer', '1', '', '',
				        0.9, 0.9, 0.9, $5)`,
				[clean.customer_no, clean.name, TODAY, doc, `t-nocite-${randomUUID()}`]
			);
		});
		expect(error.code).toBe('NL422');
		expect(error.message).toMatch(/locator and the words/);
	});

	it('refuses an attribute that is not in the data dictionary', async () => {
		const error = await attempt(async (tx) => {
			const doc = await documentWith(tx, {
				sourceKey: 'hand_entry',
				ref: `nodict-${randomUUID()}`,
				subjectId: clean.customer_no,
				text: 'They want a blanket release against the annual.',
				receivedAt: TODAY
			});
			await tx.query(
				`select nl.record_claim('customer', $1, $2, 'blanket_release_terms',
				        'annual', null, null, null, null, '', 'annual',
				        null, null, null, null, null, $3::date, $3::date, null,
				        $4, 'prose_model', '1', 'line 1',
				        'They want a blanket release against the annual.',
				        0.9, 0.9, 0.9, $5)`,
				[clean.customer_no, clean.name, TODAY, doc, `t-nodict-${randomUUID()}`]
			);
		});
		expect(error.code).toBe('NL422');
		expect(error.message).toMatch(/data dictionary/);
	});

	it('refuses a snippet that is not in the source document', async () => {
		const error = await attempt(async (tx) => {
			const doc = await documentWith(tx, {
				sourceKey: 'hand_entry',
				ref: `nospan-${randomUUID()}`,
				subjectId: clean.customer_no,
				text: 'Nothing in here about payment at all.',
				receivedAt: TODAY
			});
			await recordClaim(
				tx,
				claim({
					attribute: 'payment_terms_days',
					value: terms(45),
					sourceDocumentId: doc,
					locator: 'line 1',
					snippet: 'Their terms are Net 45, as agreed in writing.'
				})
			);
		});
		expect(error.code).toBe('NL422');
		expect(error.message).toMatch(/not in the source document/);
	});

	it('turns a value that fails validation into a data-quality item, with its words', async () => {
		const result = await db.asUser(ADMIN, async (tx) => {
			const [vendor] = await tx.sql<{ vendor_no: string; name: string }>`
				select vendor_no, name from nl.vendors order by vendor_no limit 1`;
			const doc = await documentWith(tx, {
				sourceKey: 'hand_entry',
				ref: `bad-lead-${randomUUID()}`,
				subjectKind: 'vendor',
				subjectId: vendor.vendor_no,
				text: 'Their buyer says the mill is quoting about 400 days now.',
				receivedAt: TODAY
			});
			return recordClaim(
				tx,
				claim({
					subjectKind: 'vendor',
					subjectId: vendor.vendor_no,
					subjectRaw: vendor.name,
					attribute: 'vendor_lead_time_days',
					value: {
						text: null,
						number: null,
						date: null,
						bool: null,
						json: { low: 400, high: 400 },
						unit: 'days',
						display: '400 days'
					},
					sourceDocumentId: doc,
					scope: { vendorNo: vendor.vendor_no },
					locator: 'line 1',
					snippet: 'Their buyer says the mill is quoting about 400 days now.'
				})
			);
		});

		expect(result.accepted).toBe(false);
		expect(result.claimId).toBeNull();
		expect(result.reviewItemId).not.toBeNull();
		expect(result.failures.some((failure) => failure.check === 'plausibility')).toBe(true);

		const items = await readReviewItems(db, ADMIN, 100);
		const item = items.find((row) => row.id === result.reviewItemId);
		expect(item?.kind).toBe('failed_validation');
		expect(item?.snippet).toMatch(/400 days/);
		expect(item?.reason).toMatch(/not believable/);
	});

	it('refuses a customer part number with no part in its scope', async () => {
		const result = await db.asUser(ADMIN, async (tx) => {
			const doc = await documentWith(tx, {
				sourceKey: 'mail_archive',
				ref: `noitem-${randomUUID()}`,
				subjectId: clean.customer_no,
				text: 'We call it XPT-4471 on our side.',
				receivedAt: TODAY
			});
			return recordClaim(
				tx,
				claim({
					attribute: 'customer_part_no',
					value: {
						text: 'XPT-4471',
						number: null,
						date: null,
						bool: null,
						json: null,
						unit: '',
						display: 'XPT-4471'
					},
					sourceDocumentId: doc,
					locator: 'line 1',
					snippet: 'We call it XPT-4471 on our side.'
				})
			);
		});
		expect(result.accepted).toBe(false);
		expect(result.failures.some((failure) => /name the part/.test(failure.detail))).toBe(true);
	});

	it('refuses a subject that is not one of our accounts', async () => {
		const result = await db.asUser(ADMIN, async (tx) => {
			const doc = await documentWith(tx, {
				sourceKey: 'mail_archive',
				ref: `noacct-${randomUUID()}`,
				subjectId: clean.customer_no,
				text: 'Our terms are Net 45.',
				receivedAt: TODAY
			});
			return recordClaim(
				tx,
				claim({
					subjectId: '999999',
					subjectRaw: 'Somebody else',
					attribute: 'payment_terms_days',
					value: terms(45),
					sourceDocumentId: doc,
					locator: 'line 1',
					snippet: 'Our terms are Net 45.'
				})
			);
		});
		expect(result.accepted).toBe(false);
		expect(result.failures.some((failure) => /not one of our accounts/.test(failure.detail))).toBe(true);
	});

	it('reads the same evidence twice and writes one claim', async () => {
		const [first, second] = await db.asUser(ADMIN, async (tx) => {
			const doc = await documentWith(tx, {
				sourceKey: 'mail_archive',
				ref: `twice-${randomUUID()}`,
				subjectId: clean.customer_no,
				text: 'Terms Net 45 from the invoice date.',
				receivedAt: TODAY
			});
			const one = claim({
				attribute: 'payment_terms_days',
				value: terms(45),
				sourceDocumentId: doc,
				locator: 'line 1',
				snippet: 'Terms Net 45 from the invoice date.'
			});
			return [await recordClaim(tx, one), await recordClaim(tx, one)];
		});
		expect(first.claimId).not.toBeNull();
		// The second call replays the first request id, which is derived from
		// the evidence, so it is the same claim and not a second one.
		expect(second.claimId).toBe(first.claimId);
	});
});

// ---------------------------------------------------------------------------
// Scope precedence, staleness and expiry
// ---------------------------------------------------------------------------

describe('scope, staleness and expiry', () => {
	it('lets the more specific scope win', async () => {
		const account = await db.asUser(ADMIN, async (tx) => {
			const [row] = await tx.sql<{ customer_no: string; name: string }>`
				select c.customer_no, c.name from nl.customers c
				where not c.closed and not c.blocked
				  and not exists (select 1 from nl.claims cl
				                  where cl.subject_kind = 'customer' and cl.subject_id = c.customer_no)
				  and exists (select 1 from nl.invoice_lines il where il.customer_no = c.customer_no)
				order by c.customer_no limit 1`;
			const [item] = await tx.sql<{ item_no: string }>`
				select il.item_no from nl.invoice_lines il
				join nl.items i on i.item_no = il.item_no
				where il.customer_no = ${row.customer_no} and not i.blocked
				order by il.item_no limit 1`;

			const doc = await documentWith(tx, {
				sourceKey: 'mail_archive',
				ref: `scope-${row.customer_no}`,
				subjectId: row.customer_no,
				text:
					'Everything needs a certificate of conformance.\n' +
					'On the mill test report parts we need the mill test report too.',
				receivedAt: TODAY
			});

			// Account-wide, and then a tighter rule for one part.
			await recordClaim(
				tx,
				claim({
					subjectId: row.customer_no,
					subjectRaw: row.name,
					attribute: 'certificate_required',
					value: {
						text: 'certificate_of_conformance',
						number: null,
						date: null,
						bool: null,
						json: null,
						unit: '',
						display: 'certificate of conformance'
					},
					sourceDocumentId: doc,
					locator: 'line 1',
					snippet: 'Everything needs a certificate of conformance.'
				})
			);
			await recordClaim(
				tx,
				claim({
					subjectId: row.customer_no,
					subjectRaw: row.name,
					attribute: 'certificate_required',
					value: {
						text: 'both',
						number: null,
						date: null,
						bool: null,
						json: null,
						unit: '',
						display: 'both'
					},
					scope: { itemNo: item.item_no },
					sourceDocumentId: doc,
					locator: 'line 2',
					snippet: 'On the mill test report parts we need the mill test report too.'
				})
			);
			await promoteIn(tx, { kind: 'customer', id: row.customer_no }, `t-scope-${randomUUID()}`);
			return { ...row, item_no: item.item_no };
		});

		// Both are facts: one is not wrong because the other is narrower.
		const [facts] = await db.asUser(
			ADMIN,
			(tx) => tx.sql<{ n: number }>`
				select count(*)::int as n from nl.facts
				where subject_id = ${account.customer_no} and attribute = 'certificate_required'
				  and status = 'current'`
		);
		expect(facts.n).toBe(2);

		// Asking without a part gets the account-wide answer.
		const wide = await contextValue(
			db,
			ADMIN,
			{ kind: 'customer', id: account.customer_no },
			'certificate_required'
		);
		expect(wide?.value_display).toBe('certificate of conformance');
		expect(wide?.specificity).toBe(0);

		// Asking about that part gets the tighter one.
		const narrow = await contextValue(
			db,
			ADMIN,
			{ kind: 'customer', id: account.customer_no },
			'certificate_required',
			{ itemNo: account.item_no }
		);
		expect(narrow?.value_display).toBe('both');
		expect(narrow?.specificity).toBeGreaterThan(0);
	});

	it('marks a fact stale once it is past its horizon, and leaves it out of the bundle', async () => {
		const account = await db.asUser(ADMIN, async (tx) => {
			const row = await freshAccount(tx);
			const doc = await documentWith(tx, {
				sourceKey: 'mail_archive',
				ref: `stale-${row.customer_no}`,
				subjectId: row.customer_no,
				text: 'Buyer here is Dana Whitfield.',
				receivedAt: '2024-01-10T09:00:00Z'
			});
			// primary_buyer_name has a 365 day horizon, and this was asserted
			// more than two years ago.
			await recordClaim(
				tx,
				claim({
					subjectId: row.customer_no,
					subjectRaw: row.name,
					attribute: 'primary_buyer_name',
					value: {
						text: 'Dana Whitfield',
						number: null,
						date: null,
						bool: null,
						json: null,
						unit: '',
						display: 'Dana Whitfield'
					},
					assertedAt: '2024-01-10',
					sourceDocumentId: doc,
					locator: 'line 1',
					snippet: 'Buyer here is Dana Whitfield.'
				})
			);
			await promoteIn(tx, { kind: 'customer', id: row.customer_no }, `t-stale-${randomUUID()}`);
			await compileIn(tx, { kind: 'customer', id: row.customer_no });
			return row;
		});

		const [state] = await db.asUser(
			ADMIN,
			(tx) => tx.sql<{ stale: boolean; days_stale: number; stale_after: string }>`
				select stale, days_stale, stale_after from nl.fact_state
				where subject_id = ${account.customer_no} and attribute = 'primary_buyer_name'`
		);
		expect(state.stale).toBe(true);
		// 2024 is a leap year, so 365 days on from 10 January 2024 is 9 January.
		expect(state.stale_after).toBe('2025-01-09');
		expect(Number(state.days_stale)).toBeGreaterThan(300);

		// It is reported as stale, and it is not served as a fact.
		const bundle = await contextFor(db, ADMIN, { kind: 'customer', id: account.customer_no }, 'replying_external');
		if (bundleServed(bundle)) {
			expect(bundle.facts.some((fact) => fact.attribute === 'primary_buyer_name')).toBe(false);
			expect(bundle.stale.some((fact) => fact.attribute === 'primary_buyer_name')).toBe(true);
		} else {
			// Nothing else was known for that purpose, so it refused: also fine,
			// and it names the reason rather than answering with an empty list.
			expect(bundle.reason.length).toBeGreaterThan(10);
		}
	});

	it('does not serve a fact past its valid_to', async () => {
		const account = await db.asUser(ADMIN, async (tx) => {
			const row = await freshAccount(tx);
			const doc = await documentWith(tx, {
				sourceKey: 'mail_archive',
				ref: `expired-${row.customer_no}`,
				subjectId: row.customer_no,
				text: 'We are holding the pricing through the end of October.',
				receivedAt: `${days(TODAY, -30)}T09:00:00Z`
			});
			await recordClaim(
				tx,
				claim({
					subjectId: row.customer_no,
					subjectRaw: row.name,
					attribute: 'price_hold_until',
					value: {
						text: null,
						number: null,
						date: days(TODAY, 20),
						bool: null,
						json: null,
						unit: '',
						display: days(TODAY, 20)
					},
					assertedAt: days(TODAY, -30),
					validFrom: days(TODAY, -30),
					// The window is still open today, which is why it promotes.
					validTo: days(TODAY, 20),
					sourceDocumentId: doc,
					locator: 'line 1',
					snippet: 'We are holding the pricing through the end of October.'
				})
			);
			await promoteIn(tx, { kind: 'customer', id: row.customer_no }, `t-exp-${randomUUID()}`);
			await compileIn(tx, { kind: 'customer', id: row.customer_no });
			return row;
		});

		// Today, it is a fact and it is served.
		const now = await contextValue(
			db,
			ADMIN,
			{ kind: 'customer', id: account.customer_no },
			'price_hold_until'
		);
		expect(now).not.toBeNull();

		// Now move the clock on two months, which is what nl.today() is for.
		// Nothing is edited: the same rows are read on a later day.
		const later = await db.asUser(ADMIN, async (tx) => {
			await tx.query(`select set_config('nl.today', $1, true)`, [days(TODAY, 60)]);
			await compileIn(tx, { kind: 'customer', id: account.customer_no });
			const [state] = await tx.sql<{ expired: boolean }>`
				select expired from nl.fact_state
				where subject_id = ${account.customer_no} and attribute = 'price_hold_until'`;
			const value = await tx.query<{ fact_id: number }>(
				`select fact_id from nl.context_value('customer', $1, 'price_hold_until', null, null)`,
				[account.customer_no]
			);
			const [bundle] = await tx.sql<{ bundle: Record<string, unknown> }>`
				select nl.context_for('customer', ${account.customer_no}, 'quoting') as bundle`;
			return { state, value, bundle: bundle.bundle };
		});

		expect(later.state.expired).toBe(true);
		// nl.context_value will not answer with it at all.
		expect(later.value).toHaveLength(0);
		// And the bundle REFUSES rather than serving an empty list, because
		// "we know of no price hold" and "the price hold we knew about has run
		// out" are different answers.
		expect(later.bundle.served).toBe(false);
		expect(String(later.bundle.reason)).toMatch(/expired/);
		expect(Array.isArray(later.bundle.expired)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Entity resolution
// ---------------------------------------------------------------------------

describe('entity resolution', () => {
	it('matches a buyer on file and records how sure it was', async () => {
		const resolved = await db.asUser(ADMIN, async (tx) => {
			const [contact] = await tx.sql<{ email: string; customer_no: string }>`
				select ct.email, ct.customer_no from nl.contacts ct
				join nl.customers c on c.customer_no = ct.customer_no
				where ct.email is not null and ct.is_primary and not c.closed
				order by ct.id limit 1`;
			return {
				...(await resolveDocumentSubject(tx, {
					fromAddress: contact.email,
					text: 'Our terms are Net 45.',
					companyName: null,
					kind: 'orders'
				})),
				expected: contact.customer_no
			};
		});
		expect(resolved.id).toBe(resolved.expected);
		expect(resolved.confidence).toBeGreaterThan(0.9);
		expect(resolved.reason).toMatch(/is .* at /);
	});

	it('asks a person when a chain’s branches share one domain', async () => {
		const resolved = await db.asUser(ADMIN, async (tx) => {
			// A domain more than one open account uses, which is what a chain
			// looks like in the book.
			const [shared] = await tx.sql<{ email_domain: string; n: number }>`
				select lower(c.email_domain) as email_domain, count(*)::int as n
				from nl.customers c
				where c.email_domain is not null and not c.closed and not c.blocked
				group by 1 having count(*) > 1
				order by count(*) desc, 1
				limit 1`;
			if (!shared) return null;
			return resolveDocumentSubject(tx, {
				fromAddress: `parts.counter@${shared.email_domain}`,
				// No city, no branch name: nothing to choose between them.
				text: 'How many can you ship this week?',
				companyName: null,
				kind: 'orders'
			});
		});
		if (!resolved) return;

		// Nothing is matched, and the branches that fit are handed over as
		// candidates for a person, because quoting the wrong branch is a real
		// mistake with real prices on it.
		expect(resolved.id).toBeNull();
		expect(resolved.candidates.length).toBeGreaterThan(1);
		expect(resolved.reason).toMatch(/does not say which branch/);
	});

	it('leaves an unknown sender unresolved rather than guessing', async () => {
		const resolved = await db.asUser(ADMIN, (tx) =>
			resolveDocumentSubject(tx, {
				fromAddress: 'purchasing@bellwetherpartsgroup.example',
				text: 'We are opening an account with you.',
				companyName: 'Bellwether Parts Group',
				kind: 'orders'
			})
		);
		expect(resolved.id).toBeNull();
		expect(resolved.confidence).toBeLessThan(0.4);
		expect(resolved.reason.length).toBeGreaterThan(10);
	});

	it('keeps an unresolved claim out of the facts until somebody says who it is', async () => {
		const [waiting] = await db.asUser(
			ADMIN,
			(tx) => tx.sql<{ n: number }>`
				select count(*)::int as n from nl.claims where status = 'unresolved'`
		);
		// The seed leaves one: mail from an address on nobody's file.
		expect(waiting.n).toBeGreaterThan(0);

		const [facts] = await db.asUser(
			ADMIN,
			(tx) => tx.sql<{ n: number }>`
				select count(*)::int as n from nl.facts f
				join nl.claims c on c.id = f.claim_ids[1]
				where c.status = 'unresolved'`
		);
		expect(facts.n).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// explore_sources
// ---------------------------------------------------------------------------

describe('explore_sources', () => {
	it('writes claims and no facts', async () => {
		const [before] = await db.asUser(
			ADMIN,
			(tx) => tx.sql<{ claims: number; facts: number }>`
				select (select count(*) from nl.claims)::int as claims,
				       (select count(*) from nl.facts)::int as facts`
		);

		// An account the seeded mail really does say something about.
		const [subject] = await db.asUser(
			ADMIN,
			(tx) => tx.sql<{ customer_no: string }>`
				select a.customer_no from nl.mail_archive a
				where a.customer_no is not null
				  and a.body_text like '%freight collect%'
				order by a.id limit 1`
		);
		expect(subject).toBeDefined();

		const report = await exploreSources(db, DANA, { kind: 'customer', id: subject.customer_no });

		const [after] = await db.asUser(
			ADMIN,
			(tx) => tx.sql<{ claims: number; facts: number }>`
				select (select count(*) from nl.claims)::int as claims,
				       (select count(*) from nl.facts)::int as facts`
		);

		expect(report.documentsRead).toBeGreaterThan(0);
		// It read something and it decided nothing.
		expect(after.facts).toBe(before.facts);
		expect(report.factsWritten).toBe(0);
		// And it says what would happen if the rules were run, without running
		// them, so an agent can report the state honestly.
		expect(report.wouldPromote.length).toBeGreaterThan(0);
		expect(after.claims).toBeGreaterThanOrEqual(before.claims);
	});

	it('chases one attribute when it is asked to', async () => {
		const [subject] = await db.asUser(
			ADMIN,
			(tx) => tx.sql<{ customer_no: string }>`
				select a.customer_no from nl.mail_archive a
				where a.customer_no is not null and a.body_text like '%Net 45%'
				order by a.id limit 1`
		);
		if (!subject) return;
		const report = await exploreSources(db, DANA, { kind: 'customer', id: subject.customer_no }, {
			attribute: 'payment_terms_days'
		});
		expect(report.attribute).toBe('payment_terms_days');
		for (const found of report.found) {
			expect(found.attribute).toBe('payment_terms_days');
		}
	});

	it('does nothing about an attribute this dictionary does not have', async () => {
		const report = await exploreSources(db, DANA, { kind: 'customer', id: clean.customer_no }, {
			attribute: 'not_a_real_attribute'
		});
		expect(report.documentsRead).toBe(0);
		expect(report.claimsWritten).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// The read path and the coverage list
// ---------------------------------------------------------------------------

describe('nl.context_for', () => {
	it('serves only what is above the bar, and every fact carries its citations', async () => {
		const [subject] = await db.asUser(
			ADMIN,
			(tx) => tx.sql<{ subject_id: string }>`
				select subject_id from nl.facts
				where subject_kind = 'customer' and status = 'current'
				group by subject_id order by count(*) desc limit 1`
		);
		const bundle = await contextFor(db, ADMIN, { kind: 'customer', id: subject.subject_id }, 'internal_review');
		expect(bundleServed(bundle)).toBe(true);
		if (!bundleServed(bundle)) return;

		const bar = bundle.policy.read_min_confidence;
		expect(bar).toBeGreaterThan(0);
		for (const fact of bundle.facts) {
			expect(fact.confidence).toBeGreaterThanOrEqual(bar);
			// The trust claim: every fact carries the words it came from.
			expect(fact.citations.length).toBeGreaterThan(0);
			for (const citation of fact.citations) {
				expect(citation.snippet.length).toBeGreaterThan(5);
				expect(citation.locator.length).toBeGreaterThan(2);
				expect(citation.source_name.length).toBeGreaterThan(2);
			}
		}
		// And the bundle says which version and how old it is, always.
		expect(bundle.bundle_version).toBeGreaterThan(0);
		expect(bundle.content_hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it('keeps an internal attribute out of a bundle for an external reply', async () => {
		const account = await db.asUser(ADMIN, async (tx) => {
			const row = await freshAccount(tx);
			const doc = await documentWith(tx, {
				sourceKey: 'hand_entry',
				ref: `internal-${row.customer_no}`,
				subjectId: row.customer_no,
				text:
					'They are on credit hold until the March invoices clear.\n' +
					'Terms are Net 30 meanwhile.',
				receivedAt: TODAY
			});
			// credit_status_note is marked internal and listed on the quoting
			// surface: relevant to quoting, never sayable to a customer.
			await recordClaim(
				tx,
				claim({
					subjectId: row.customer_no,
					subjectRaw: row.name,
					attribute: 'credit_status_note',
					value: {
						text: 'on credit hold until the March invoices clear',
						number: null,
						date: null,
						bool: null,
						json: null,
						unit: '',
						display: 'on credit hold until the March invoices clear'
					},
					sourceDocumentId: doc,
					locator: 'line 1',
					snippet: 'They are on credit hold until the March invoices clear.'
				})
			);
			await recordClaim(
				tx,
				claim({
					subjectId: row.customer_no,
					subjectRaw: row.name,
					attribute: 'payment_terms_days',
					value: terms(30),
					sourceDocumentId: doc,
					locator: 'line 2',
					snippet: 'Terms are Net 30 meanwhile.'
				})
			);
			await promoteIn(tx, { kind: 'customer', id: row.customer_no }, `t-internal-${randomUUID()}`);
			await compileIn(tx, { kind: 'customer', id: row.customer_no });
			return row;
		});

		const internal = await contextFor(db, ADMIN, { kind: 'customer', id: account.customer_no }, 'internal_review');
		const external = await contextFor(db, ADMIN, { kind: 'customer', id: account.customer_no }, 'replying_external');
		const quoting = await contextFor(db, ADMIN, { kind: 'customer', id: account.customer_no }, 'quoting');

		expect(bundleServed(internal)).toBe(true);
		if (bundleServed(internal)) {
			expect(internal.facts.some((fact) => fact.attribute === 'credit_status_note')).toBe(true);
			expect(internal.external).toBe(false);
		}

		// Not in either external bundle, even the one whose surface the
		// attribute names: the disclosure class beats the surface list.
		for (const bundle of [external, quoting]) {
			if (bundleServed(bundle)) {
				expect(bundle.external).toBe(true);
				expect(bundle.facts.some((fact) => fact.attribute === 'credit_status_note')).toBe(false);
			}
		}
		// The terms, which a customer may hear, are in the external bundle.
		if (bundleServed(external)) {
			expect(external.facts.some((fact) => fact.attribute === 'payment_terms_days')).toBe(true);
		}
	});

	it('refuses, with a reason, when nothing has been compiled', async () => {
		const bundle = await contextFor(db, ADMIN, { kind: 'customer', id: '999999' }, 'quoting');
		expect(bundle.served).toBe(false);
		if (!bundleServed(bundle)) {
			expect(bundle.reason).toMatch(/No context has been compiled/);
		}
	});
});

describe('the coverage list', () => {
	it('reports an attribute the seeded mess never mentions as missing everywhere', async () => {
		const rows = await readCoverage(db, ADMIN, 60);
		// Nothing in the seeded world says anything about a substitute part.
		const substitute = rows.find(
			(row) => row.attribute === 'item_substitute_part_no' && row.subject_kind === 'item'
		);
		expect(substitute).toBeDefined();
		expect(substitute!.verified).toBe(0);
		expect(substitute!.stale).toBe(0);
		expect(substitute!.missing).toBe(substitute!.subjects);
		expect(substitute!.coverage_pct).toBe(0);

		// And the list is a work list: the worst rows come first.
		const percentages = rows.map((row) => Number(row.coverage_pct));
		expect(percentages).toEqual([...percentages].sort((a, b) => a - b));
	});

	it('finds the subjects behind a gap, heaviest first', async () => {
		const gaps = await db.asUser(ADMIN, (tx) =>
			tx.query<{ subject_id: string; weight: number; state: string }>(
				`select * from nl.context_gaps('customer', 'preferred_carrier', 5)`
			)
		);
		expect(gaps.length).toBeGreaterThan(0);
		for (const gap of gaps) {
			expect(['missing', 'stale', 'expired']).toContain(gap.state);
		}
		const weights = gaps.map((gap) => Number(gap.weight));
		expect(weights).toEqual([...weights].sort((a, b) => b - a));
	});
});

// ---------------------------------------------------------------------------
// The seeded world
// ---------------------------------------------------------------------------

describe('the seeded world', () => {
	it('already holds facts, at least one conflict and at least one stale fact', async () => {
		const [counts] = await db.asUser(
			ADMIN,
			(tx) => tx.sql<{
				sources: number;
				documents: number;
				claims: number;
				facts: number;
				stale: number;
				conflicts: number;
				review: number;
				bundles: number;
				playbooks: number;
				archive: number;
				legacy: number;
			}>`
				select (select count(*) from nl.sources)::int as sources,
				       (select count(*) from nl.source_documents)::int as documents,
				       (select count(*) from nl.claims)::int as claims,
				       (select count(*) from nl.facts where status = 'current')::int as facts,
				       (select count(*) from nl.fact_state where stale)::int as stale,
				       (select count(*) from nl.context_conflicts where status = 'open')::int as conflicts,
				       (select count(*) from nl.context_review_items where status = 'open')::int as review,
				       (select count(*) from nl.context_bundles where is_current)::int as bundles,
				       (select count(*) from nl.playbooks where active)::int as playbooks,
				       (select count(*) from nl.mail_archive)::int as archive,
				       (select count(*) from nl.legacy_crm_rows)::int as legacy`
		);

		// The screens are never empty by accident.
		expect(counts.facts).toBeGreaterThan(10);
		expect(counts.stale).toBeGreaterThan(0);
		expect(counts.review).toBeGreaterThan(0);
		expect(counts.bundles).toBeGreaterThan(0);
		expect(counts.playbooks).toBeGreaterThanOrEqual(5);
		// The brief asks for 60 to 120 archived letters.
		expect(counts.archive).toBeGreaterThanOrEqual(60);
		expect(counts.archive).toBeLessThanOrEqual(120);
		expect(counts.legacy).toBeGreaterThan(15);
		expect(counts.sources).toBe(8);
	});

	it('has conflicts a person can actually decide, with both citations on them', async () => {
		const conflicts = await readConflicts(db, ADMIN, 20);
		expect(conflicts.length).toBeGreaterThan(0);
		for (const conflict of conflicts) {
			expect(conflict.winner.snippet.length).toBeGreaterThan(5);
			expect(conflict.rival.snippet.length).toBeGreaterThan(5);
			expect(conflict.winner.value_display).not.toBe(conflict.rival.value_display);
			expect(conflict.attribute_label.length).toBeGreaterThan(2);
			expect(conflict.row_version).toMatch(/^\d{4}-/);
		}
	});

	it('keeps the legacy export dirty rather than cleaning it in place', async () => {
		const [mess] = await db.asUser(
			ADMIN,
			(tx) => tx.sql<{ duplicates: number; phones: number; second_terms: number }>`
				select
				  (select count(*) from nl.legacy_crm_rows where raw ->> 'acct_no' = '')::int as duplicates,
				  (select count(*) from nl.legacy_crm_rows
				   where raw ->> 'acct_name' like '555-01%')::int as phones,
				  (select count(*) from nl.legacy_crm_rows
				   where raw ->> 'record' = 'TERMS')::int as second_terms`
		);
		expect(mess.duplicates).toBeGreaterThan(0);
		expect(mess.phones).toBeGreaterThan(0);
		expect(mess.second_terms).toBeGreaterThan(0);
	});
});
