// The six account writes. Each one checks the form's shape here with zod and
// then calls the SQL function of the same name, which enforces the meaning:
// who may write, what the fields must look like, the row version, the audit
// row and the request id that makes a retry safe.
import { z } from 'zod';
import type { Db } from '../db/types.ts';
import { guarded } from '../errors.ts';

const requestId = z.string().min(8).max(100);
const rowVersion = z.iso.datetime({ offset: true });
const customerNo = z.string().trim().min(1).max(20);
// An empty text field means "not given", not "the empty string".
const optionalText = z
	.string()
	.trim()
	.max(200)
	.transform((value) => (value === '' ? null : value));

export interface ContactWriteResult {
	contactId: number;
	isPrimary: boolean;
	replayed: boolean;
}

const contactFields = {
	fullName: z.string().trim().min(2).max(100),
	title: z.string().trim().max(80).default(''),
	email: optionalText,
	phone: optionalText,
	mobile: optionalText,
	notes: z.string().trim().max(1000).default(''),
	// Checkboxes arrive as 'on' when ticked and not at all when not.
	isPrimary: z.union([z.literal('on'), z.literal('true')]).optional().transform((v) => v !== undefined)
};

export const addContactInput = z.object({
	customerNo,
	...contactFields,
	requestId
});

export type AddContactInput = z.infer<typeof addContactInput>;

interface ContactRow {
	result: { contact_id: number; is_primary: boolean; replayed?: boolean };
}

export async function addContact(
	db: Db,
	userId: number,
	input: AddContactInput,
	via: 'ui' | 'assistant' = 'ui'
): Promise<ContactWriteResult> {
	const [row] = await guarded(() =>
		db.asUser(userId, (tx) =>
			tx.sql<ContactRow>`
				select nl.add_contact(${input.customerNo}, ${input.fullName}, ${input.title}, ${input.email},
				                     ${input.phone}, ${input.mobile}, ${input.isPrimary}, ${input.notes},
				                     ${input.requestId}, ${via}) as result`
		)
	);
	return {
		contactId: row.result.contact_id,
		isPrimary: row.result.is_primary,
		replayed: row.result.replayed === true
	};
}

export const updateContactInput = z.object({
	contactId: z.coerce.number().int().positive(),
	...contactFields,
	left: z.union([z.literal('on'), z.literal('true')]).optional().transform((v) => v !== undefined),
	expectedUpdatedAt: rowVersion,
	requestId
});

export type UpdateContactInput = z.infer<typeof updateContactInput>;

export async function updateContact(
	db: Db,
	userId: number,
	input: UpdateContactInput,
	via: 'ui' | 'assistant' = 'ui'
): Promise<ContactWriteResult> {
	const [row] = await guarded(() =>
		db.asUser(userId, (tx) =>
			tx.sql<ContactRow>`
				select nl.update_contact(${input.contactId}, ${input.fullName}, ${input.title}, ${input.email},
				                        ${input.phone}, ${input.mobile}, ${input.isPrimary}, ${input.left},
				                        ${input.notes}, ${input.expectedUpdatedAt}::timestamptz,
				                        ${input.requestId}, ${via}) as result`
		)
	);
	return {
		contactId: row.result.contact_id,
		isPrimary: row.result.is_primary,
		replayed: row.result.replayed === true
	};
}

export const setBuyerInput = z.object({
	commitmentId: z.coerce.number().int().positive(),
	// An empty value clears the buyer.
	contactId: z
		.string()
		.trim()
		.regex(/^\d{0,18}$/)
		.transform((value) => (value === '' ? null : Number(value))),
	expectedUpdatedAt: rowVersion,
	requestId
});

export type SetBuyerInput = z.infer<typeof setBuyerInput>;

export interface BuyerWriteResult {
	commitmentId: number;
	buyerContactId: number | null;
	updatedAt: string;
	replayed: boolean;
}

export async function setCommitmentBuyer(
	db: Db,
	userId: number,
	input: SetBuyerInput,
	via: 'ui' | 'assistant' = 'ui'
): Promise<BuyerWriteResult> {
	const [row] = await guarded(() =>
		db.asUser(userId, (tx) =>
			tx.sql<{ result: { commitment_id: number; buyer_contact_id: number | null; updated_at: string; replayed?: boolean } }>`
				select nl.set_commitment_buyer(${input.commitmentId}, ${input.contactId}::bigint,
				                              ${input.expectedUpdatedAt}::timestamptz, ${input.requestId},
				                              ${via}) as result`
		)
	);
	return {
		commitmentId: row.result.commitment_id,
		buyerContactId: row.result.buyer_contact_id,
		updatedAt: row.result.updated_at,
		replayed: row.result.replayed === true
	};
}

/** Add a person at the commitment's account and name them its buyer, in one transaction. */
export const addBuyerInput = z.object({
	commitmentId: z.coerce.number().int().positive(),
	customerNo,
	fullName: contactFields.fullName,
	title: contactFields.title,
	email: optionalText,
	phone: optionalText,
	expectedUpdatedAt: rowVersion,
	requestId
});

export type AddBuyerInput = z.infer<typeof addBuyerInput>;

export async function addContactAsBuyer(
	db: Db,
	userId: number,
	input: AddBuyerInput,
	via: 'ui' | 'assistant' = 'ui'
): Promise<BuyerWriteResult & { contactId: number }> {
	// Two writes, one transaction: either both happen or neither does. Each
	// needs its own request id, so both are derived from the form's.
	return guarded(() =>
		db.asUser(userId, async (tx) => {
			const [added] = await tx.sql<ContactRow>`
				select nl.add_contact(${input.customerNo}, ${input.fullName}, ${input.title}, ${input.email},
				                     ${input.phone}, null, false, '', ${`${input.requestId}-c`}, ${via}) as result`;
			const [named] = await tx.sql<{
				result: { commitment_id: number; buyer_contact_id: number | null; updated_at: string; replayed?: boolean };
			}>`
				select nl.set_commitment_buyer(${input.commitmentId}, ${added.result.contact_id}::bigint,
				                              ${input.expectedUpdatedAt}::timestamptz, ${`${input.requestId}-b`},
				                              ${via}) as result`;
			return {
				contactId: added.result.contact_id,
				commitmentId: named.result.commitment_id,
				buyerContactId: named.result.buyer_contact_id,
				updatedAt: named.result.updated_at,
				replayed: named.result.replayed === true
			};
		})
	);
}

export const logActivityInput = z.object({
	customerNo,
	kind: z.enum(['note', 'call', 'email', 'meeting']),
	callOutcome: z
		.union([z.enum(['reached', 'voicemail', 'no_answer', 'callback']), z.literal('')])
		.optional()
		.transform((value) => (value === '' || value === undefined ? null : value)),
	body: z.string().trim().min(1).max(2000),
	contactId: z
		.string()
		.trim()
		.regex(/^\d{0,18}$/)
		.optional()
		.transform((value) => (value === '' || value === undefined ? null : Number(value))),
	commitmentId: z
		.string()
		.trim()
		.regex(/^\d{0,18}$/)
		.optional()
		.transform((value) => (value === '' || value === undefined ? null : Number(value))),
	// A datetime-local field: '2026-09-17T14:30', read as the company's time.
	occurredAt: z
		.string()
		.trim()
		.regex(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?)?$/)
		.optional()
		.transform((value) => (value === '' || value === undefined ? null : value)),
	requestId
});

export type LogActivityInput = z.infer<typeof logActivityInput>;

export interface ActivityWriteResult {
	activityId: number;
	kind: string;
	replayed: boolean;
}

export async function logActivity(
	db: Db,
	userId: number,
	input: LogActivityInput,
	via: 'ui' | 'assistant' = 'ui'
): Promise<ActivityWriteResult> {
	const [row] = await guarded(() =>
		db.asUser(userId, (tx) =>
			tx.sql<{ result: { activity_id: number; kind: string; replayed?: boolean } }>`
				select nl.log_activity(${input.customerNo}, ${input.kind}, ${input.callOutcome}, ${input.body},
				                      ${input.contactId}::bigint, ${input.commitmentId}::bigint,
				                      -- A local time in the company's zone, or now when the field was left empty.
				                      (${input.occurredAt}::timestamp at time zone 'America/Chicago'),
				                      ${input.requestId}, ${via}) as result`
		)
	);
	return {
		activityId: row.result.activity_id,
		kind: row.result.kind,
		replayed: row.result.replayed === true
	};
}

export const addNextStepInput = z.object({
	customerNo,
	title: z.string().trim().min(3).max(200),
	dueOn: z
		.string()
		.trim()
		.regex(/^(\d{4}-\d{2}-\d{2})?$/)
		.optional()
		.transform((value) => (value === '' || value === undefined ? null : value)),
	ownerId: z.coerce.number().int().positive(),
	commitmentId: z
		.string()
		.trim()
		.regex(/^\d{0,18}$/)
		.optional()
		.transform((value) => (value === '' || value === undefined ? null : Number(value))),
	requestId
});

export type AddNextStepInput = z.infer<typeof addNextStepInput>;

export interface StepWriteResult {
	nextStepId: number;
	replayed: boolean;
}

export async function addNextStep(
	db: Db,
	userId: number,
	input: AddNextStepInput,
	via: 'ui' | 'assistant' = 'ui'
): Promise<StepWriteResult> {
	const [row] = await guarded(() =>
		db.asUser(userId, (tx) =>
			tx.sql<{ result: { next_step_id: number; replayed?: boolean } }>`
				select nl.add_next_step(${input.customerNo}, ${input.title}, ${input.dueOn}::date, ${input.ownerId},
				                       ${input.commitmentId}::bigint, ${input.requestId}, ${via}) as result`
		)
	);
	return { nextStepId: row.result.next_step_id, replayed: row.result.replayed === true };
}

export const completeNextStepInput = z.object({
	stepId: z.coerce.number().int().positive(),
	expectedUpdatedAt: rowVersion,
	requestId
});

export type CompleteNextStepInput = z.infer<typeof completeNextStepInput>;

export async function completeNextStep(
	db: Db,
	userId: number,
	input: CompleteNextStepInput,
	via: 'ui' | 'assistant' = 'ui'
): Promise<StepWriteResult> {
	const [row] = await guarded(() =>
		db.asUser(userId, (tx) =>
			tx.sql<{ result: { next_step_id: number; replayed?: boolean } }>`
				select nl.complete_next_step(${input.stepId}, ${input.expectedUpdatedAt}::timestamptz,
				                            ${input.requestId}, ${via}) as result`
		)
	);
	return { nextStepId: row.result.next_step_id, replayed: row.result.replayed === true };
}
