// Accounts, contacts and activity: the six write functions, the numbers the
// accounts list shows, and what the seed extra puts in the world.
//
// One small world for the whole file, "today" pinned to 2026-09-17. The tests
// build their own accounts (TA-...) so nothing in the seeded world can change
// what they measure, except where a test says it reads the world on purpose.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../db/pglite.ts';
import type { Db } from '../db/types.ts';
import {
	getAccountHeader,
	getAccountNumbers,
	getContacts,
	getDeals,
	getNextSteps,
	getOrders,
	getTimeline,
	listBuyerChoices
} from './account.ts';
import { listAccounts, readFilters } from './list.ts';
import {
	addContact,
	addContactAsBuyer,
	addNextStep,
	completeNextStep,
	logActivity,
	setCommitmentBuyer,
	updateContact
} from './writes.ts';

const ADMIN = 1; // Elena Brooks
const DANA = 2; // owns the test accounts
const MARCUS = 3; // another account manager
const TERRY = 7; // no longer active

// The name scan's word list lives outside the repo, so this file spells no
// banned word out in full. These are the two things generated text could
// plausibly hit: a word for "expedite" that collides with a name, and
// placeholder Latin.
const BANNED_PATTERN = ['lorem', 'r' + 'ush'].join('|');

const HQ = 'TA-HQ';
const BRANCH = 'TA-BR';
const OTHER = 'TA-OTHER'; // owned by Marcus, a different family

let db: Db;
let commitmentId: number;
let otherCommitmentId: number;

beforeAll(async () => {
	db = await createTestDb();
	await db.asSystem(async (tx) => {
		await tx.sql`insert into nl.items (item_no, description, category, family, product_group, unit_cost, list_price, replenishment)
		             values ('ZC-100', 'TEST PART', 'PIPE', 'pipe', 'PIPE', 10, 40, 'Prod. Order')`;
		await tx.sql`insert into nl.customers (customer_no, name, price_group, owner_id, customer_since, email_domain)
		             values (${HQ}, 'Test Fleet Supply', 'DEALER', ${DANA}, '2020-01-01', 'testfleet.example')`;
		await tx.sql`insert into nl.customers (customer_no, name, bill_to_no, price_group, owner_id, customer_since, email_domain)
		             values (${BRANCH}, 'Test Fleet Supply - Waco', ${HQ}, 'DEALER', ${DANA}, '2021-01-01', 'testfleet.example')`;
		await tx.sql`insert into nl.customers (customer_no, name, price_group, owner_id, customer_since, email_domain)
		             values (${OTHER}, 'Other Test Diesel', 'DEALER', ${MARCUS}, '2020-01-01', 'othertest.example')`;
		// Two invoices this year and one last year, so the list view has
		// something to add up.
		for (const [no, customer, postedOn, subtotal] of [
			['TI-1', HQ, '2026-03-04', 4000],
			['TI-2', HQ, '2026-07-09', 2500],
			['TI-3', HQ, '2025-03-04', 1000],
			['TI-4', BRANCH, '2026-04-01', 700]
		] as [string, string, string, number][]) {
			await tx.sql`insert into nl.invoices (invoice_no, doc_type, customer_no, bill_to_no, posted_on, subtotal)
			             values (${no}, 'invoice', ${customer}, ${HQ}, ${postedOn}, ${subtotal})`;
			await tx.sql`insert into nl.invoice_lines (invoice_no, line_no, customer_no, posted_on, item_no,
			                                           quantity, unit_price, amount, unit_cost)
			             values (${no}, 1, ${customer}, ${postedOn}, 'ZC-100', 1, ${subtotal}, ${subtotal}, 10)`;
		}
		const [commitment] = await tx.sql<{ id: number }>`
			insert into nl.commitments (title, customer_no, owner_id, committed_value, starts_on, ends_on, created_by)
			values ('Test commitment', ${HQ}, ${DANA}, 20000, '2026-08-01', '2026-12-31', ${DANA})
			returning id`;
		commitmentId = commitment.id;
		const [other] = await tx.sql<{ id: number }>`
			insert into nl.commitments (title, customer_no, owner_id, committed_value, starts_on, ends_on, created_by)
			values ('Other commitment', ${OTHER}, ${MARCUS}, 5000, '2026-08-01', '2026-12-31', ${MARCUS})
			returning id`;
		otherCommitmentId = other.id;
	});
});

afterAll(async () => {
	await db?.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A fresh contact at an account, written straight to the table (not a test of the write). */
async function seedContact(
	customerNo: string,
	fullName: string,
	options: { title?: string; primary?: boolean; leftOn?: string | null; createdBy?: number | null } = {}
): Promise<{ id: number; version: string }> {
	const [row] = await db.asSystem((tx) =>
		tx.sql<{ id: number; updated_at: Date }>`
			insert into nl.contacts (customer_no, full_name, title, email, phone, is_primary, left_on, created_by)
			values (${customerNo}, ${fullName}, ${options.title ?? 'Buyer'},
			        ${`${fullName.toLowerCase().replace(/ /g, '.')}@testfleet.example`},
			        '(555) 555-0123', ${options.primary ?? false}, ${options.leftOn ?? null},
			        ${options.createdBy ?? null})
			returning id, updated_at`
	);
	return { id: row.id, version: row.updated_at.toISOString() };
}

async function contactRow(id: number) {
	const [row] = await db.asSystem((tx) =>
		tx.sql<{
			customer_no: string;
			full_name: string;
			title: string;
			email: string | null;
			phone: string | null;
			mobile: string | null;
			notes: string;
			is_primary: boolean;
			left_on: string | null;
			created_by: number | null;
			updated_at: Date;
		}>`select * from nl.contacts where id = ${id}`
	);
	return row;
}

async function commitmentVersion(id: number): Promise<string> {
	const [row] = await db.asSystem(
		(tx) => tx.sql<{ updated_at: Date }>`select updated_at from nl.commitments where id = ${id}`
	);
	return row.updated_at.toISOString();
}

async function buyerOf(id: number): Promise<number | null> {
	const [row] = await db.asSystem(
		(tx) => tx.sql<{ buyer_contact_id: number | null }>`select buyer_contact_id from nl.commitments where id = ${id}`
	);
	return row.buyer_contact_id;
}

async function auditRows(entity: string, entityId: string) {
	return db.asSystem((tx) =>
		tx.sql<{ action: string; actor_id: number; via: string }>`
			select action, actor_id, via from nl.audit_log
			where entity = ${entity} and entity_id = ${entityId} order by id`
	);
}

async function stepRow(id: number) {
	const [row] = await db.asSystem((tx) =>
		tx.sql<{ completed_at: Date | null; completed_by: number | null; owner_id: number; updated_at: Date }>`
			select completed_at, completed_by, owner_id, updated_at from nl.next_steps where id = ${id}`
	);
	return row;
}

function contactForm(fullName: string, extra: Record<string, string | boolean> = {}) {
	return {
		fullName,
		title: 'Parts Manager',
		email: null,
		phone: null,
		mobile: null,
		notes: '',
		isPrimary: false,
		...extra
	};
}

// ---------------------------------------------------------------------------
// Adding a contact
// ---------------------------------------------------------------------------

describe('adding a contact', () => {
	it('adds the first person as the primary contact, and writes an audit row', async () => {
		const result = await addContact(db, DANA, {
			customerNo: BRANCH,
			...contactForm('Avery Brennan'),
			email: 'avery.brennan@testfleet.example',
			phone: '(555) 555-0142 x12',
			mobile: '(555) 555-0143',
			notes: 'Counts stock on Fridays.',
			requestId: randomUUID()
		});
		expect(result.isPrimary).toBe(true);
		const row = await contactRow(result.contactId);
		expect(row).toMatchObject({
			customer_no: BRANCH,
			full_name: 'Avery Brennan',
			email: 'avery.brennan@testfleet.example',
			mobile: '(555) 555-0143',
			is_primary: true,
			created_by: DANA
		});
		expect(await auditRows('contact', String(result.contactId))).toEqual([
			{ action: 'add_contact', actor_id: DANA, via: 'ui' }
		]);
	});

	it('leaves the badge alone for the next person, and moves it when asked', async () => {
		const second = await addContact(db, DANA, {
			customerNo: BRANCH,
			...contactForm('Rowan Foster'),
			requestId: randomUUID()
		});
		expect(second.isPrimary).toBe(false);

		const third = await addContact(db, DANA, {
			customerNo: BRANCH,
			...contactForm('Kendall Pruitt', { isPrimary: true }),
			requestId: randomUUID()
		});
		expect(third.isPrimary).toBe(true);
		const [primaries] = await db.asSystem(
			(tx) => tx.sql<{ n: number }>`select count(*)::int as n from nl.contacts
			                              where customer_no = ${BRANCH} and is_primary`
		);
		expect(primaries.n).toBe(1);
		expect((await contactRow(third.contactId)).is_primary).toBe(true);
	});

	// Anyone signed in may add a contact, so there is no 403 here: adding
	// information about a person is additive and audited. The refusals are
	// about the user being inactive and about the fields themselves.
	it('refuses a user who is no longer active', async () => {
		await expect(
			addContact(db, TERRY, { customerNo: HQ, ...contactForm('Nobody Here'), requestId: randomUUID() })
		).rejects.toMatchObject({ status: 401 });
	});

	it('refuses an account that does not exist', async () => {
		await expect(
			addContact(db, DANA, { customerNo: 'TA-NONE', ...contactForm('Ghost Buyer'), requestId: randomUUID() })
		).rejects.toMatchObject({ status: 404 });
	});

	it('refuses a name that is too short, a bad email, a bad phone and a duplicate email', async () => {
		await expect(
			addContact(db, DANA, { customerNo: HQ, ...contactForm('A'), requestId: randomUUID() })
		).rejects.toMatchObject({ status: 422 });
		await expect(
			addContact(db, DANA, {
				customerNo: HQ,
				...contactForm('Bad Email', { }),
				email: 'not-an-address',
				requestId: randomUUID()
			})
		).rejects.toMatchObject({ status: 422 });
		await expect(
			addContact(db, DANA, {
				customerNo: HQ,
				...contactForm('Bad Phone'),
				phone: 'call the shop',
				requestId: randomUUID()
			})
		).rejects.toMatchObject({ status: 422 });

		const email = 'twice@testfleet.example';
		await addContact(db, DANA, { customerNo: HQ, ...contactForm('First Person'), email, requestId: randomUUID() });
		await expect(
			addContact(db, DANA, { customerNo: HQ, ...contactForm('Second Person'), email, requestId: randomUUID() })
		).rejects.toMatchObject({ status: 422 });
	});

	it('writes once when the same request arrives twice', async () => {
		const input = { customerNo: HQ, ...contactForm('Replay Tester'), requestId: randomUUID() };
		const first = await addContact(db, DANA, input);
		const second = await addContact(db, DANA, input);
		expect(first.replayed).toBe(false);
		expect(second.replayed).toBe(true);
		expect(second.contactId).toBe(first.contactId);
		const [count] = await db.asSystem(
			(tx) => tx.sql<{ n: number }>`select count(*)::int as n from nl.contacts
			                              where customer_no = ${HQ} and full_name = 'Replay Tester'`
		);
		expect(count.n).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Changing a contact
// ---------------------------------------------------------------------------

describe('changing a contact', () => {
	function edit(
		id: number,
		version: string,
		extra: Record<string, string | boolean | null> = {}
	) {
		return {
			contactId: id,
			fullName: 'Casey Holloway',
			title: 'Purchasing Agent',
			email: null,
			phone: null,
			mobile: null,
			notes: '',
			isPrimary: false,
			left: false,
			expectedUpdatedAt: version,
			requestId: randomUUID(),
			...extra
		} as Parameters<typeof updateContact>[2];
	}

	it("lets the account's owner change the details and moves the row version", async () => {
		const person = await seedContact(HQ, 'Casey Holloway');
		await updateContact(db, DANA, edit(person.id, person.version, { title: 'Fleet Maintenance Manager' }));
		const row = await contactRow(person.id);
		expect(row.title).toBe('Fleet Maintenance Manager');
		expect(row.updated_at.toISOString()).not.toBe(person.version);
		expect((await auditRows('contact', String(person.id)))[0]).toMatchObject({
			action: 'update_contact',
			actor_id: DANA
		});
	});

	it('refuses another account manager, and lets an admin through', async () => {
		const person = await seedContact(HQ, 'Casey Holloway');
		await expect(updateContact(db, MARCUS, edit(person.id, person.version))).rejects.toMatchObject({
			status: 403
		});
		await updateContact(db, ADMIN, edit(person.id, person.version, { notes: 'Fixed by an admin.' }));
		expect((await contactRow(person.id)).notes).toBe('Fixed by an admin.');
	});

	it('lets whoever added a contact change it, on anyone else\'s account', async () => {
		const person = await seedContact(OTHER, 'Marcus Guest', { createdBy: DANA });
		await updateContact(db, DANA, edit(person.id, person.version, { fullName: 'Marcus Guest' }));
		expect((await contactRow(person.id)).full_name).toBe('Marcus Guest');
	});

	it('refuses a user who is no longer active', async () => {
		const person = await seedContact(HQ, 'Casey Holloway');
		await expect(updateContact(db, TERRY, edit(person.id, person.version))).rejects.toMatchObject({
			status: 401
		});
	});

	it('refuses a change made from a stale page', async () => {
		const person = await seedContact(HQ, 'Casey Holloway');
		await updateContact(db, DANA, edit(person.id, person.version, { title: 'Buyer' }));
		await expect(
			updateContact(db, DANA, edit(person.id, person.version, { title: 'Owner' }))
		).rejects.toMatchObject({ status: 409 });
		expect((await contactRow(person.id)).title).toBe('Buyer');
	});

	it('refuses a bad phone number and a contact that does not exist', async () => {
		const person = await seedContact(HQ, 'Casey Holloway');
		await expect(
			updateContact(db, DANA, edit(person.id, person.version, { phone: 'ring the counter' }))
		).rejects.toMatchObject({ status: 422 });
		await expect(updateContact(db, DANA, edit(999999, person.version))).rejects.toMatchObject({ status: 404 });
	});

	it('records that someone left, and refuses to leave them as the primary contact', async () => {
		const person = await seedContact(HQ, 'Casey Holloway', { primary: false });
		await expect(
			updateContact(db, DANA, edit(person.id, person.version, { left: true, isPrimary: true }))
		).rejects.toMatchObject({ status: 422 });
		await updateContact(db, DANA, edit(person.id, person.version, { left: true }));
		const row = await contactRow(person.id);
		expect(row.left_on).toBe('2026-09-17');
		expect(row.is_primary).toBe(false);
	});

	it('writes once when the same request arrives twice', async () => {
		const person = await seedContact(HQ, 'Casey Holloway');
		const input = edit(person.id, person.version, { title: 'Counter Lead' });
		const first = await updateContact(db, DANA, input);
		const second = await updateContact(db, DANA, input);
		expect(first.replayed).toBe(false);
		expect(second.replayed).toBe(true);
		expect(await auditRows('contact', String(person.id))).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Naming the buyer on a commitment
// ---------------------------------------------------------------------------

describe('naming a commitment buyer', () => {
	function name(contactId: number | null, version: string) {
		return {
			commitmentId,
			contactId,
			expectedUpdatedAt: version,
			requestId: randomUUID()
		};
	}

	it('lets the owner name someone at the account, and clear them again', async () => {
		const person = await seedContact(HQ, 'Quinn Sandoval');
		const result = await setCommitmentBuyer(db, DANA, name(person.id, await commitmentVersion(commitmentId)));
		expect(result.buyerContactId).toBe(person.id);
		expect(await buyerOf(commitmentId)).toBe(person.id);

		await setCommitmentBuyer(db, DANA, name(null, await commitmentVersion(commitmentId)));
		expect(await buyerOf(commitmentId)).toBeNull();
		expect((await auditRows('commitment', String(commitmentId))).map((a) => a.action)).toEqual([
			'set_commitment_buyer',
			'set_commitment_buyer'
		]);
	});

	it('accepts someone at a branch that bills to this account', async () => {
		const person = await seedContact(BRANCH, 'Jesse Navarro');
		await setCommitmentBuyer(db, DANA, name(person.id, await commitmentVersion(commitmentId)));
		expect(await buyerOf(commitmentId)).toBe(person.id);
	});

	it('refuses a contact from another account', async () => {
		const stranger = await seedContact(OTHER, 'Wrong Account');
		const before = await buyerOf(commitmentId);
		await expect(
			setCommitmentBuyer(db, DANA, name(stranger.id, await commitmentVersion(commitmentId)))
		).rejects.toMatchObject({ status: 422 });
		expect(await buyerOf(commitmentId)).toBe(before);
	});

	it('refuses someone who is no longer there, and a contact that does not exist', async () => {
		const leaver = await seedContact(HQ, 'Gone Already', { leftOn: '2026-01-31' });
		await expect(
			setCommitmentBuyer(db, DANA, name(leaver.id, await commitmentVersion(commitmentId)))
		).rejects.toMatchObject({ status: 422 });
		await expect(
			setCommitmentBuyer(db, DANA, name(999999, await commitmentVersion(commitmentId)))
		).rejects.toMatchObject({ status: 422 });
	});

	it('refuses another account manager and accepts an admin', async () => {
		const person = await seedContact(HQ, 'Terry Ellison');
		await expect(
			setCommitmentBuyer(db, MARCUS, name(person.id, await commitmentVersion(commitmentId)))
		).rejects.toMatchObject({ status: 403 });
		await setCommitmentBuyer(db, ADMIN, name(person.id, await commitmentVersion(commitmentId)));
		expect(await buyerOf(commitmentId)).toBe(person.id);
	});

	it('refuses a commitment that does not exist, and a stale row version', async () => {
		const person = await seedContact(HQ, 'Stale Page');
		await expect(
			setCommitmentBuyer(db, DANA, {
				commitmentId: 999999,
				contactId: person.id,
				expectedUpdatedAt: await commitmentVersion(commitmentId),
				requestId: randomUUID()
			})
		).rejects.toMatchObject({ status: 404 });

		const stale = await commitmentVersion(commitmentId);
		await setCommitmentBuyer(db, DANA, name(person.id, stale));
		await expect(setCommitmentBuyer(db, DANA, name(null, stale))).rejects.toMatchObject({ status: 409 });
	});

	it('writes once when the same request arrives twice', async () => {
		const person = await seedContact(HQ, 'Twice Named');
		const input = name(person.id, await commitmentVersion(commitmentId));
		const first = await setCommitmentBuyer(db, DANA, input);
		const second = await setCommitmentBuyer(db, DANA, input);
		expect(first.replayed).toBe(false);
		expect(second.replayed).toBe(true);
		expect(second.updatedAt).toBe(first.updatedAt);
	});

	it('adds a new person and names them the buyer in one transaction', async () => {
		const result = await addContactAsBuyer(db, MARCUS, {
			commitmentId: otherCommitmentId,
			customerNo: OTHER,
			fullName: 'Blake Ibarra',
			title: 'Buyer',
			email: 'blake.ibarra@othertest.example',
			phone: null,
			expectedUpdatedAt: await commitmentVersion(otherCommitmentId),
			requestId: randomUUID()
		});
		expect(await buyerOf(otherCommitmentId)).toBe(result.contactId);
		expect((await contactRow(result.contactId)).customer_no).toBe(OTHER);
	});

	it('adds nobody when naming the buyer is refused', async () => {
		const before = await db.asSystem(
			(tx) => tx.sql<{ n: number }>`select count(*)::int as n from nl.contacts where customer_no = ${HQ}`
		);
		// Marcus does not own this commitment, so the second half refuses and
		// the contact added by the first half rolls back with it.
		await expect(
			addContactAsBuyer(db, MARCUS, {
				commitmentId,
				customerNo: HQ,
				fullName: 'Never Added',
				title: 'Buyer',
				email: null,
				phone: null,
				expectedUpdatedAt: await commitmentVersion(commitmentId),
				requestId: randomUUID()
			})
		).rejects.toMatchObject({ status: 403 });
		const after = await db.asSystem(
			(tx) => tx.sql<{ n: number }>`select count(*)::int as n from nl.contacts where customer_no = ${HQ}`
		);
		expect(after[0].n).toBe(before[0].n);
	});

	it('offers the people at the account and its family as choices', async () => {
		const choices = await listBuyerChoices(db, DANA, commitmentId);
		const accounts = new Set(choices.map((c) => c.customerNo));
		expect(accounts).toEqual(new Set([HQ, BRANCH]));
		expect(choices.some((c) => c.fullName === 'Gone Already')).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Logging activity
// ---------------------------------------------------------------------------

describe('logging activity', () => {
	function entry(extra: Record<string, unknown> = {}) {
		return {
			customerNo: HQ,
			kind: 'call' as const,
			callOutcome: 'reached' as const,
			body: 'Went through stack lengths for the new units.',
			contactId: null,
			commitmentId: null,
			occurredAt: null,
			requestId: randomUUID(),
			...extra
		} as Parameters<typeof logActivity>[2];
	}

	it("lets anyone log a call on someone else's account, in their own name", async () => {
		const result = await logActivity(db, MARCUS, entry({ commitmentId }));
		const [row] = await db.asSystem(
			(tx) => tx.sql<{ author_id: number; kind: string; call_outcome: string; via: string; commitment_id: number }>`
				select author_id, kind, call_outcome, via, commitment_id from nl.activities where id = ${result.activityId}`
		);
		expect(row).toMatchObject({
			author_id: MARCUS,
			kind: 'call',
			call_outcome: 'reached',
			via: 'ui',
			commitment_id: commitmentId
		});
		expect(await auditRows('activity', String(result.activityId))).toEqual([
			{ action: 'log_activity', actor_id: MARCUS, via: 'ui' }
		]);
	});

	it('names the contact it was with', async () => {
		const person = await seedContact(HQ, 'Dana Whitfield');
		await logActivity(db, DANA, entry({ kind: 'email', callOutcome: null, contactId: person.id }));
		const timeline = await getTimeline(db, DANA, HQ);
		expect(timeline.entries[0].contactName).toBe('Dana Whitfield');
		expect(timeline.entries[0].kind).toBe('email');
		expect(timeline.total).toBeGreaterThan(1);
	});

	it('insists a call says how it went, and that nothing else does', async () => {
		await expect(logActivity(db, DANA, entry({ callOutcome: null }))).rejects.toMatchObject({ status: 422 });
		await expect(
			logActivity(db, DANA, entry({ kind: 'note', callOutcome: 'reached' }))
		).rejects.toMatchObject({ status: 422 });
	});

	it('refuses an empty body, a future time and an old time', async () => {
		await expect(logActivity(db, DANA, entry({ body: '' }))).rejects.toMatchObject({ status: 422 });
		const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		await expect(logActivity(db, DANA, entry({ occurredAt: soon }))).rejects.toMatchObject({ status: 422 });
		await expect(logActivity(db, DANA, entry({ occurredAt: '2024-01-01T09:00:00Z' }))).rejects.toMatchObject({
			status: 422
		});
	});

	it('refuses a contact or a commitment from another account', async () => {
		const stranger = await seedContact(OTHER, 'Not Here');
		await expect(logActivity(db, DANA, entry({ contactId: stranger.id }))).rejects.toMatchObject({
			status: 422
		});
		await expect(
			logActivity(db, DANA, entry({ commitmentId: otherCommitmentId }))
		).rejects.toMatchObject({ status: 422 });
	});

	it('refuses an unknown account and a user who is no longer active', async () => {
		await expect(logActivity(db, DANA, entry({ customerNo: 'TA-NONE' }))).rejects.toMatchObject({
			status: 404
		});
		await expect(logActivity(db, TERRY, entry())).rejects.toMatchObject({ status: 401 });
	});

	it('writes once when the same request arrives twice', async () => {
		const input = entry({ body: 'Logged twice by one retry.' });
		const first = await logActivity(db, DANA, input);
		const second = await logActivity(db, DANA, input);
		expect(second.replayed).toBe(true);
		expect(second.activityId).toBe(first.activityId);
		const [count] = await db.asSystem(
			(tx) => tx.sql<{ n: number }>`select count(*)::int as n from nl.activities
			                              where body = 'Logged twice by one retry.'`
		);
		expect(count.n).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Next steps
// ---------------------------------------------------------------------------

describe('next steps', () => {
	function step(extra: Record<string, unknown> = {}) {
		return {
			customerNo: HQ,
			title: 'Send the chrome stack quote',
			dueOn: '2026-09-30',
			ownerId: DANA,
			commitmentId: null,
			requestId: randomUUID(),
			...extra
		} as Parameters<typeof addNextStep>[2];
	}

	it('adds a step for an active colleague, with an audit row', async () => {
		const result = await addNextStep(db, MARCUS, step({ ownerId: DANA, commitmentId }));
		const [row] = await db.asSystem(
			(tx) => tx.sql<{ owner_id: number; created_by: number; due_on: string; commitment_id: number }>`
				select owner_id, created_by, due_on, commitment_id from nl.next_steps where id = ${result.nextStepId}`
		);
		expect(row).toMatchObject({ owner_id: DANA, created_by: MARCUS, due_on: '2026-09-30', commitment_id: commitmentId });
		expect(await auditRows('next_step', String(result.nextStepId))).toEqual([
			{ action: 'add_next_step', actor_id: MARCUS, via: 'ui' }
		]);
	});

	it('refuses a colleague who no longer works here, a due date in the past and a short title', async () => {
		await expect(addNextStep(db, DANA, step({ ownerId: TERRY }))).rejects.toMatchObject({ status: 422 });
		await expect(addNextStep(db, DANA, step({ dueOn: '2026-09-16' }))).rejects.toMatchObject({ status: 422 });
		await expect(addNextStep(db, DANA, step({ title: 'go' }))).rejects.toMatchObject({ status: 422 });
	});

	it('refuses an unknown account, a commitment from elsewhere and an inactive user', async () => {
		await expect(addNextStep(db, DANA, step({ customerNo: 'TA-NONE' }))).rejects.toMatchObject({ status: 404 });
		await expect(addNextStep(db, DANA, step({ commitmentId: otherCommitmentId }))).rejects.toMatchObject({
			status: 422
		});
		await expect(addNextStep(db, TERRY, step())).rejects.toMatchObject({ status: 401 });
	});

	it('writes one step when the same request arrives twice', async () => {
		const input = step({ title: 'Only added once' });
		const first = await addNextStep(db, DANA, input);
		const second = await addNextStep(db, DANA, input);
		expect(second.replayed).toBe(true);
		expect(second.nextStepId).toBe(first.nextStepId);
	});

	it('lets the step owner complete it, and the account owner too', async () => {
		const mine = await addNextStep(db, MARCUS, step({ ownerId: MARCUS }));
		let version = (await stepRow(mine.nextStepId)).updated_at.toISOString();
		await completeNextStep(db, MARCUS, {
			stepId: mine.nextStepId,
			expectedUpdatedAt: version,
			requestId: randomUUID()
		});
		const done = await stepRow(mine.nextStepId);
		expect(done.completed_by).toBe(MARCUS);
		expect(done.completed_at).not.toBeNull();

		// Dana owns the account, so she may close a step that belongs to Marcus.
		const theirs = await addNextStep(db, MARCUS, step({ ownerId: MARCUS }));
		version = (await stepRow(theirs.nextStepId)).updated_at.toISOString();
		await completeNextStep(db, DANA, {
			stepId: theirs.nextStepId,
			expectedUpdatedAt: version,
			requestId: randomUUID()
		});
		expect((await stepRow(theirs.nextStepId)).completed_by).toBe(DANA);
	});

	it('refuses someone with no claim on the step, a repeat, a stale version and an unknown step', async () => {
		const theirs = await addNextStep(db, MARCUS, { ...step({ customerNo: OTHER, ownerId: MARCUS }) });
		const version = (await stepRow(theirs.nextStepId)).updated_at.toISOString();
		// Dana owns neither the step nor the account it sits on.
		await expect(
			completeNextStep(db, DANA, {
				stepId: theirs.nextStepId,
				expectedUpdatedAt: version,
				requestId: randomUUID()
			})
		).rejects.toMatchObject({ status: 403 });

		await completeNextStep(db, MARCUS, {
			stepId: theirs.nextStepId,
			expectedUpdatedAt: version,
			requestId: randomUUID()
		});
		const after = (await stepRow(theirs.nextStepId)).updated_at.toISOString();
		await expect(
			completeNextStep(db, MARCUS, {
				stepId: theirs.nextStepId,
				expectedUpdatedAt: after,
				requestId: randomUUID()
			})
		).rejects.toMatchObject({ status: 422 });

		const open = await addNextStep(db, DANA, step());
		await expect(
			completeNextStep(db, DANA, {
				stepId: open.nextStepId,
				expectedUpdatedAt: '2020-01-01T00:00:00.000Z',
				requestId: randomUUID()
			})
		).rejects.toMatchObject({ status: 409 });
		await expect(
			completeNextStep(db, DANA, {
				stepId: 999999,
				expectedUpdatedAt: '2020-01-01T00:00:00.000Z',
				requestId: randomUUID()
			})
		).rejects.toMatchObject({ status: 404 });
	});

	it('completes once when the same request arrives twice', async () => {
		const mine = await addNextStep(db, DANA, step({ title: 'Completed once' }));
		const version = (await stepRow(mine.nextStepId)).updated_at.toISOString();
		const input = { stepId: mine.nextStepId, expectedUpdatedAt: version, requestId: randomUUID() };
		const first = await completeNextStep(db, DANA, input);
		const second = await completeNextStep(db, DANA, input);
		expect(first.replayed).toBe(false);
		expect(second.replayed).toBe(true);
		expect(await auditRows('next_step', String(mine.nextStepId))).toHaveLength(2); // added, completed
	});

	it('shows open steps with overdue marked and recently finished ones after them', async () => {
		const steps = await getNextSteps(db, DANA, HQ);
		expect(steps.length).toBeGreaterThan(0);
		expect(steps.filter((s) => !s.done).every((s) => s.canComplete)).toBe(true);
		// Open steps come before finished ones.
		const firstDone = steps.findIndex((s) => s.done);
		if (firstDone >= 0) expect(steps.slice(firstDone).every((s) => s.done)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// The accounts list and the account page
// ---------------------------------------------------------------------------

describe('the accounts list', () => {
	it('matches a direct computation of the numbers for a few accounts', async () => {
		const sample = await db.asSystem(
			(tx) => tx.sql<{ customer_no: string }>`
				select customer_no from nl.account_list
				where revenue_ytd > 0 order by revenue_ytd desc limit 3`
		);
		expect(sample.length).toBe(3);

		for (const { customer_no } of [...sample, { customer_no: HQ }]) {
			const [view] = await db.asUser(DANA, (tx) =>
				tx.sql<{
					revenue_ytd: number;
					revenue_prior_ytd: number;
					revenue_last_year: number;
					last_order_on: string | null;
					open_commitments: number;
					open_committed: number;
					contact_count: number;
					branch_count: number;
					open_steps: number;
				}>`select revenue_ytd, revenue_prior_ytd, revenue_last_year, last_order_on, open_commitments,
				          open_committed, contact_count, branch_count, open_steps
				   from nl.account_list where customer_no = ${customer_no}`
			);
			const [direct] = await db.asSystem((tx) =>
				tx.sql<{
					revenue_ytd: number;
					revenue_prior_ytd: number;
					revenue_last_year: number;
					last_order_on: string | null;
					open_commitments: number;
					open_committed: number;
					contact_count: number;
					branch_count: number;
					open_steps: number;
				}>`
					select
					  coalesce((select sum(subtotal) from nl.invoices
					             where customer_no = ${customer_no}
					               and posted_on between date_trunc('year', nl.today())::date and nl.today()), 0)
					    as revenue_ytd,
					  coalesce((select sum(subtotal) from nl.invoices
					             where customer_no = ${customer_no}
					               and posted_on between (date_trunc('year', nl.today()) - interval '1 year')::date
					                                and (nl.today() - interval '1 year')::date), 0)
					    as revenue_prior_ytd,
					  coalesce((select sum(subtotal) from nl.invoices
					             where customer_no = ${customer_no}
					               and posted_on >= (date_trunc('year', nl.today()) - interval '1 year')::date
					               and posted_on < date_trunc('year', nl.today())::date), 0)
					    as revenue_last_year,
					  (select max(posted_on) from nl.invoices
					    where customer_no = ${customer_no} and doc_type = 'invoice') as last_order_on,
					  (select count(*)::int from nl.commitment_progress
					    where customer_no = ${customer_no} and not is_settled) as open_commitments,
					  coalesce((select sum(committed_value) from nl.commitment_progress
					             where customer_no = ${customer_no} and not is_settled), 0) as open_committed,
					  (select count(*)::int from nl.contacts
					    where customer_no = ${customer_no} and left_on is null) as contact_count,
					  (select count(*)::int from nl.customers where bill_to_no = ${customer_no}) as branch_count,
					  (select count(*)::int from nl.next_steps
					    where customer_no = ${customer_no} and completed_at is null) as open_steps`
			);
			expect(view, customer_no).toEqual(direct);
		}
	});

	it('shows the test account with its rhythm and its people', async () => {
		const [row] = await db.asUser(DANA, (tx) =>
			tx.sql<{ revenue_ytd: number; days_quiet: number; primary_contact_name: string | null; parent_name: string | null }>`
				select revenue_ytd, days_quiet, primary_contact_name, parent_name
				from nl.account_list where customer_no = ${BRANCH}`
		);
		expect(row.revenue_ytd).toBe(700);
		expect(row.parent_name).toBe('Test Fleet Supply');
		// The first person added in this file was the branch's primary contact.
		expect(row.primary_contact_name).toBe('Kendall Pruitt');
		expect(row.days_quiet).toBeGreaterThan(0);
	});

	it('searches, filters and sorts, and counts the matches', async () => {
		const filters = readFilters(new URLSearchParams('q=Test Fleet&who=all&sort=name'), 'all');
		const page = await listAccounts(db, DANA, filters);
		expect(page.rows.map((r) => r.customerNo)).toEqual([HQ, BRANCH]);
		expect(page.total).toBe(2);

		const mine = await listAccounts(db, MARCUS, readFilters(new URLSearchParams('who=mine'), 'all'));
		expect(mine.rows.every((r) => r.ownerName === 'Marcus Bell')).toBe(true);
		expect(mine.rows.some((r) => r.customerNo === OTHER)).toBe(true);

		const quiet = await listAccounts(db, DANA, readFilters(new URLSearchParams('who=all&quiet=1'), 'all'));
		expect(quiet.rows.every((r) => r.goneQuiet)).toBe(true);

		const open = await listAccounts(db, DANA, readFilters(new URLSearchParams('who=all&open=1'), 'all'));
		expect(open.rows.every((r) => r.openCommitments > 0)).toBe(true);

		// A search for a wildcard is a search for that character, not for everything.
		const literal = await listAccounts(db, DANA, readFilters(new URLSearchParams('q=%25&who=all'), 'all'));
		expect(literal.total).toBe(0);

		const byRevenue = await listAccounts(db, DANA, readFilters(new URLSearchParams('who=all'), 'all'));
		const revenues = byRevenue.rows.map((r) => r.revenueYtd);
		expect([...revenues].sort((a, b) => b - a)).toEqual(revenues);
	});

	it('reads a page of the whole book without a filter', async () => {
		const page = await listAccounts(db, ADMIN, readFilters(new URLSearchParams(), 'all'));
		expect(page.rows.length).toBe(page.pageSize);
		expect(page.total).toBeGreaterThan(page.pageSize);
	});

	it('builds the account header with its branches and the people a step can go to', async () => {
		const header = await getAccountHeader(db, DANA, HQ);
		expect(header).not.toBeNull();
		expect(header!.branches.map((b) => b.customerNo)).toEqual([BRANCH]);
		expect(header!.priceGroupLabel).toBe('Dealer');
		expect(header!.today).toBe('2026-09-17');
		expect(header!.people.some((p) => p.id === TERRY)).toBe(false);
		expect(await getAccountHeader(db, DANA, 'TA-NONE')).toBeNull();
	});

	it('builds the numbers behind the bars, for the test family and for a seeded account', async () => {
		const numbers = await getAccountNumbers(db, DANA, HQ);
		expect(numbers.months).toHaveLength(24);
		expect(numbers.months[23].month.slice(0, 7)).toBe('2026-09');
		// The branch's invoice counts toward the family, not toward this account.
		expect(numbers.revenueYtd).toBe(6500);
		expect(numbers.familyRevenueYtd).toBe(7200);
		expect(numbers.months.find((m) => m.month === '2026-03-01')?.revenue).toBe(4000);

		const [busiest] = await db.asSystem(
			(tx) => tx.sql<{ customer_no: string }>`
				select customer_no from nl.account_list order by revenue_ytd desc limit 1`
		);
		const seeded = await getAccountNumbers(db, DANA, busiest.customer_no);
		expect(seeded.months).toHaveLength(24);
		expect(seeded.months.reduce((sum, m) => sum + m.revenue, 0)).toBeGreaterThan(0);
	});

	it('reads the commitments, quotes, open lines and invoices a page shows', async () => {
		const deals = await getDeals(db, DANA, BRANCH);
		// The commitment sits on the head office; the branch's page shows it.
		expect(deals.commitments.map((c) => c.id)).toContain(commitmentId);
		expect(deals.quotes.every((q) => q.total >= 0)).toBe(true);
		expect(Array.isArray(deals.rfqDrafts)).toBe(true);

		const orders = await getOrders(db, DANA, HQ);
		expect(orders.invoices.map((i) => i.invoiceNo)).toEqual(['TI-2', 'TI-1', 'TI-3']);
		expect(orders.invoices[0].topParts).toEqual(['ZC-100']);
		expect(orders.openLines).toEqual([]);

		// A seeded account with quotes on file, to prove that query runs too.
		const [withQuote] = await db.asSystem(
			(tx) => tx.sql<{ customer_no: string }>`select customer_no from nl.quotes limit 1`
		);
		if (withQuote) {
			const seeded = await getDeals(db, ADMIN, withQuote.customer_no);
			expect(seeded.quotes.length).toBeGreaterThan(0);
		}
	});

	it('lists current people before the ones who left', async () => {
		const contacts = await getContacts(db, DANA, HQ);
		const firstGone = contacts.findIndex((c) => c.leftOn !== null);
		expect(firstGone).toBeGreaterThan(0);
		expect(contacts.slice(firstGone).every((c) => c.leftOn !== null)).toBe(true);
		expect(contacts.filter((c) => c.isPrimary).length).toBeLessThan(2);
	});
});

// ---------------------------------------------------------------------------
// What the seed extra put in the world
// ---------------------------------------------------------------------------

describe('the world the seed extra builds', () => {
	it('gives active accounts two to four people, exactly one of them primary', async () => {
		const [counts] = await db.asSystem(
			(tx) => tx.sql<{ accounts: number; with_two: number; too_many_primary: number; primary_left: number }>`
				with live as (
				  select c.customer_no
				  from nl.customers c
				  where c.bill_to_no is null
				    and exists (select 1 from nl.invoices i
				                where i.customer_no = c.customer_no and i.posted_on > nl.today() - 730)
				),
				per_account as (
				  select l.customer_no,
				         count(ct.id) filter (where ct.left_on is null) as current_people,
				         count(ct.id) filter (where ct.is_primary) as primaries
				  from live l
				  left join nl.contacts ct on ct.customer_no = l.customer_no
				  group by l.customer_no
				)
				select count(*)::int as accounts,
				       count(*) filter (where current_people between 2 and 4)::int as with_two,
				       count(*) filter (where primaries > 1)::int as too_many_primary,
				       (select count(*)::int from nl.contacts where is_primary and left_on is not null) as primary_left
				from per_account`
		);
		expect(counts.accounts).toBeGreaterThan(5);
		// Nearly every live account has a small team on file, not one name.
		expect(counts.with_two / counts.accounts).toBeGreaterThan(0.8);
		expect(counts.too_many_primary).toBe(0);
		expect(counts.primary_left).toBe(0);
	});

	it('fills in titles, work emails, direct lines and some mobiles', async () => {
		const [shape] = await db.asSystem(
			(tx) => tx.sql<{
				people: number;
				titled: number;
				with_email: number;
				with_phone: number;
				with_mobile: number;
				odd_domain: number;
				former: number;
			}>`
				select count(*)::int as people,
				       count(*) filter (where title <> '')::int as titled,
				       count(*) filter (where email is not null)::int as with_email,
				       count(*) filter (where phone is not null)::int as with_phone,
				       count(*) filter (where mobile is not null)::int as with_mobile,
				       count(*) filter (where email is not null and email not like '%.example')::int as odd_domain,
				       count(*) filter (where left_on is not null)::int as former
				from nl.contacts
				where customer_no not like 'TA-%'`
		);
		expect(shape.people).toBeGreaterThan(100);
		expect(shape.titled).toBe(shape.people);
		expect(shape.with_email).toBe(shape.people);
		expect(shape.with_phone).toBe(shape.people);
		expect(shape.with_mobile).toBeGreaterThan(10);
		expect(shape.odd_domain).toBe(0);
		// Some people have moved on, so the page can say "no longer there".
		expect(shape.former).toBeGreaterThan(0);
	});

	it('names a buyer on most open commitments, and leaves one to be named', async () => {
		const [buyers] = await db.asSystem(
			(tx) => tx.sql<{ open: number; named: number; buyer_titles: number }>`
				select count(*)::int as open,
				       count(*) filter (where p.buyer_contact_id is not null)::int as named,
				       count(*) filter (where ct.title ~* 'buyer|purchas|parts')::int as buyer_titles
				from nl.commitment_progress p
				left join nl.contacts ct on ct.id = p.buyer_contact_id
				where not p.is_settled and p.id < 3000000 and p.customer_no not like 'TA-%'`
		);
		expect(buyers.open).toBeGreaterThan(3);
		expect(buyers.named / buyers.open).toBeGreaterThan(0.5);
		expect(buyers.open - buyers.named).toBeGreaterThan(0);
		expect(buyers.buyer_titles).toBe(buyers.named);
	});

	it('leaves a year of calls, emails, meetings and notes behind', async () => {
		const kinds = await db.asSystem(
			(tx) => tx.sql<{ kind: string; n: number; with_outcome: number; oldest: string; newest: string }>`
				select kind, count(*)::int as n,
				       count(call_outcome)::int as with_outcome,
				       min(occurred_at)::date::text as oldest,
				       max(occurred_at)::date::text as newest
				from nl.activities where via = 'seed' group by kind order by kind`
		);
		expect(kinds.map((k) => k.kind)).toEqual(['call', 'email', 'meeting', 'note']);
		for (const kind of kinds) {
			expect(kind.n, kind.kind).toBeGreaterThan(10);
			// Only a call says how it went.
			expect(kind.with_outcome, kind.kind).toBe(kind.kind === 'call' ? kind.n : 0);
			expect(kind.newest <= '2026-09-17', kind.kind).toBe(true);
			expect(kind.oldest >= '2025-09-01', kind.kind).toBe(true);
		}
		const [total] = await db.asSystem(
			(tx) => tx.sql<{ n: number; named: number }>`
				select count(*)::int as n, count(contact_id)::int as named
				from nl.activities where via = 'seed'`
		);
		expect(total.n).toBeGreaterThan(200);
		// Most of it was with somebody, not with the account in the abstract.
		expect(total.named / total.n).toBeGreaterThan(0.5);
	});

	it('writes activity that reads like a sales team wrote it', async () => {
		const [text] = await db.asSystem(
			(tx) => tx.sql<{
				n: number;
				short: number;
				em_dash: number;
				banned: number;
				leftovers: number;
				real_parts: number;
				real_people: number;
			}>`
				select count(*)::int as n,
				       count(*) filter (where length(a.body) < 12)::int as short,
				       count(*) filter (where a.body like '%' || chr(8212) || '%'
				                           or a.body like '%' || chr(8211) || '%')::int as em_dash,
				       count(*) filter (where a.body ~* ${BANNED_PATTERN})::int as banned,
				       count(*) filter (where a.body like '%$s%' or a.body like '%null%'
				                           or a.body like '%undefined%')::int as leftovers,
				       -- Part numbers in the text are real parts from the catalog.
				       count(*) filter (where exists (
				         select 1 from nl.items i where a.body like '%' || i.item_no || '%'))::int as real_parts,
				       -- And the people named work at that account.
				       count(*) filter (where exists (
				         select 1 from nl.contacts ct
				         where ct.customer_no = a.customer_no
				           and a.body like '%' || split_part(ct.full_name, ' ', 1) || '%'))::int as real_people
				from nl.activities a where a.via = 'seed'`
		);
		expect(text.short).toBe(0);
		expect(text.em_dash).toBe(0);
		expect(text.banned).toBe(0);
		expect(text.leftovers).toBe(0);
		expect(text.real_parts).toBeGreaterThan(50);
		expect(text.real_people).toBeGreaterThan(50);
	});

	it('leaves next steps with due dates: some overdue, some done by someone', async () => {
		const [steps] = await db.asSystem(
			(tx) => tx.sql<{ n: number; open: number; overdue: number; done: number; done_by_nobody: number; dated: number }>`
				select count(*)::int as n,
				       count(*) filter (where completed_at is null)::int as open,
				       count(*) filter (where completed_at is null and due_on < nl.today())::int as overdue,
				       count(*) filter (where completed_at is not null)::int as done,
				       count(*) filter (where completed_at is not null and completed_by is null)::int as done_by_nobody,
				       count(*) filter (where due_on is not null)::int as dated
				from nl.next_steps where customer_no not like 'TA-%'`
		);
		expect(steps.n).toBeGreaterThan(30);
		expect(steps.open).toBeGreaterThan(5);
		expect(steps.overdue).toBeGreaterThan(0);
		expect(steps.done).toBeGreaterThan(5);
		expect(steps.done_by_nobody).toBe(0);
		expect(steps.dated).toBe(steps.n);
	});

	it('keeps contact notes clean too', async () => {
		const [notes] = await db.asSystem(
			(tx) => tx.sql<{ with_notes: number; em_dash: number; banned: number }>`
				select count(*) filter (where notes <> '')::int as with_notes,
				       count(*) filter (where notes like '%' || chr(8212) || '%')::int as em_dash,
				       count(*) filter (where notes ~* ${BANNED_PATTERN})::int as banned
				from nl.contacts`
		);
		expect(notes.with_notes).toBeGreaterThan(5);
		expect(notes.em_dash).toBe(0);
		expect(notes.banned).toBe(0);
	});
});
