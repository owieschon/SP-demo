// Decision records: every promise with the basis it rested on, what happened
// next, and the calibration that comes out of the two.
//
// The rules live in migration 0039 and nowhere else:
//
//   nl.date_promise_for(item, from)        the date, its basis and a confidence
//   nl.promise_a_date(...)                 record one, basis included by force
//   nl.record_promise(...)                 record any other kind
//   nl.settle_promise(...)                 what happened
//   nl.promise_record                      the outcome join
//   nl.vendor_promise_record               the line a vendor page prints
//   nl.part_promise_record                 the record behind one part's date
//   nl.maker_promise_record                per person and per agent
//   nl.record_alternatives(...)            what was considered and passed over
//   nl.also_considered(run_key)            that payload, disclosure applied
//
// Like the pricing module, nothing here decides anything. The one thing this
// file does add is refusing to build a promise by hand: there is no function
// that takes a date and writes it, only one that asks the database for a date
// and records what came back with it.
import type { Db, Tx } from '../db/types.ts';
import { guarded } from '../errors.ts';
import type {
	ConsideredChoice,
	ConsideredOption,
	DatePromise,
	MakerPromiseRecord,
	PartPromiseRecord,
	PromiseKind,
	PromiseOutcome,
	PromiseRecord,
	VendorPromiseRecord
} from './types.ts';

interface WriteRow<T> {
	result: T;
}

// ---------------------------------------------------------------------------
// Making a promise
// ---------------------------------------------------------------------------

/**
 * The date to promise for a part, with the basis and the confidence already
 * attached. A caller cannot get a date out of this module without the two
 * facts that make it scoreable coming with it.
 */
export async function getDatePromise(
	db: Db,
	userId: number,
	itemNo: string,
	fromDate?: string | null
): Promise<DatePromise | null> {
	const rows = await db.asUser(userId, (tx) =>
		tx.sql<{
			item_no: string;
			promised_date: string;
			lead_days: number;
			basis: DatePromise['basis'];
			basis_detail: string;
			confidence: number;
			confidence_basis: DatePromise['confidenceBasis'];
			can_promise: boolean;
			vendor_no: string | null;
			correction_days: number;
			correction_level: DatePromise['correctionLevel'];
		}>`select * from nl.date_promise_for(${itemNo}, ${fromDate ?? null}::date)`
	);
	const r = rows[0];
	if (!r) return null;
	return {
		itemNo: r.item_no,
		promisedDate: r.promised_date,
		leadDays: r.lead_days,
		basis: r.basis,
		basisDetail: r.basis_detail,
		confidence: r.confidence,
		confidenceBasis: r.confidence_basis,
		canPromise: r.can_promise,
		vendorNo: r.vendor_no,
		correctionDays: r.correction_days,
		correctionLevel: r.correction_level
	};
}

export interface DatePromiseInput {
	/** What the promise is about: `purchase_request_line`, `quote_revision_line`, `order_line`. */
	subject: string;
	subjectId: string;
	itemNo: string;
	customerNo?: string | null;
	/** The day the clock starts. Defaults to today in the database. */
	fromDate?: string | null;
	/** The harness run that produced it, when an agent did. */
	runKey?: string | null;
	requestId: string;
}

/**
 * Record a date promise from the rule. The basis and the confidence come from
 * the database, so neither can be left off, and the whole call is refused for
 * a part that should not be given a date at all (allocation, discontinued).
 */
export async function promiseADate(
	db: Db,
	userId: number,
	input: DatePromiseInput
): Promise<{ promiseId: number; basis: string; confidence: number; recorded: boolean }> {
	const [row] = await guarded(() =>
		db.asUser(userId, (tx) =>
			tx.sql<WriteRow<{ promise_id: number; basis: string; confidence: number; recorded: boolean }>>`
				select nl.promise_a_date(${input.subject}, ${input.subjectId}, ${input.itemNo},
				                         ${input.customerNo ?? null}, ${input.fromDate ?? null}::date,
				                         ${input.runKey ?? null}, ${input.requestId}) as result`
		)
	);
	return {
		promiseId: Number(row.result.promise_id),
		basis: String(row.result.basis ?? ''),
		confidence: Number(row.result.confidence ?? 0),
		recorded: row.result.recorded === true
	};
}

export interface PromiseInput {
	kind: PromiseKind;
	subject: string;
	subjectId: string;
	itemNo?: string | null;
	customerNo?: string | null;
	vendorNo?: string | null;
	promisedDate?: string | null;
	promisedValue?: number | null;
	/** Required. The database refuses a promise with no basis. */
	basis: string;
	basisDetail?: string;
	/** Required. `nl.default_confidence(basis)` is the honest fallback. */
	confidence: number;
	confidenceBasis: string;
	asOf?: string | null;
	runKey?: string | null;
	requestId: string;
}

/**
 * Record a promise the lead time rule does not cover: a price held on a quote,
 * a coverage figure a buyer decided. Takes a Tx, so it can go in the same
 * transaction as the thing it is a promise about.
 */
export async function recordPromise(
	tx: Tx,
	input: PromiseInput
): Promise<{ promiseId: number; recorded: boolean }> {
	const [row] = await tx.sql<WriteRow<{ promise_id: number; recorded: boolean }>>`
		select nl.record_promise(${input.kind}, ${input.subject}, ${input.subjectId},
		                         ${input.itemNo ?? null}, ${input.customerNo ?? null},
		                         ${input.vendorNo ?? null}, ${input.promisedDate ?? null}::date,
		                         ${input.promisedValue ?? null}, ${input.basis},
		                         ${input.basisDetail ?? ''}, ${input.confidence},
		                         ${input.confidenceBasis}, ${input.asOf ?? null}::date,
		                         ${input.runKey ?? null}, ${input.requestId}) as result`;
	return { promiseId: Number(row.result.promise_id), recorded: row.result.recorded === true };
}

/** The same thing, in its own transaction, as one person. */
export async function recordPromiseAs(db: Db, userId: number, input: PromiseInput) {
	return guarded(() => db.asUser(userId, (tx) => recordPromise(tx, input)));
}

export interface SettleInput {
	promiseId: number;
	outcome: PromiseOutcome;
	actualDate?: string | null;
	actualValue?: number | null;
	/** Where the answer came from: `receipt`, `quote revision`, `stock`, `person`. */
	source: string;
	detail?: string;
	requestId: string;
}

/** Settle a promise against what actually happened. Once, and then it stays settled. */
export async function settlePromise(
	db: Db,
	userId: number,
	input: SettleInput
): Promise<{ promiseId: number; outcome: string; recorded: boolean }> {
	const [row] = await guarded(() =>
		db.asUser(userId, (tx) =>
			tx.sql<WriteRow<{ promise_id: number; outcome: string; recorded: boolean }>>`
				select nl.settle_promise(${input.promiseId}, ${input.outcome},
				                         ${input.actualDate ?? null}::date,
				                         ${input.actualValue ?? null}, ${input.source},
				                         ${input.detail ?? ''}, ${input.requestId}) as result`
		)
	);
	return {
		promiseId: Number(row.result.promise_id),
		outcome: String(row.result.outcome),
		recorded: row.result.recorded === true
	};
}

// ---------------------------------------------------------------------------
// Reading the record
// ---------------------------------------------------------------------------

export interface PromiseFilter {
	vendorNo?: string | null;
	itemNo?: string | null;
	customerNo?: string | null;
	madeBy?: number | null;
	kind?: PromiseKind | null;
	/** `open`, `kept`, `missed`, `void`, or null for all of them. */
	status?: string | null;
	limit?: number;
}

/** Promises joined forward to what happened, newest first. */
export async function getPromiseRecord(
	db: Db,
	userId: number,
	filter: PromiseFilter = {}
): Promise<PromiseRecord[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.query<{
			id: number;
			kind: PromiseKind;
			subject: string;
			subject_id: string;
			item_no: string | null;
			family: string | null;
			customer_no: string | null;
			vendor_no: string | null;
			promised_date: string | null;
			promised_value: number | null;
			basis: PromiseRecord['basis'];
			basis_detail: string;
			confidence: number;
			confidence_basis: PromiseRecord['confidenceBasis'];
			as_of: string;
			made_by: number;
			maker_name: string | null;
			maker_kind: string | null;
			run_key: string | null;
			status: PromiseRecord['status'];
			actual_date: string | null;
			actual_value: number | null;
			settled_on: string | null;
			outcome_source: string | null;
			outcome_detail: string | null;
			days_out: number | null;
			value_out: number | null;
			on_time: boolean | null;
			counted: boolean;
		}>(
			`select * from nl.promise_record r
			 where ($1::text is null or r.vendor_no = $1)
			   and ($2::text is null or r.item_no = $2)
			   and ($3::text is null or r.customer_no = $3)
			   and ($4::int is null or r.made_by = $4)
			   and ($5::text is null or r.kind = $5)
			   and ($6::text is null or r.status = $6)
			 order by r.as_of desc, r.id desc
			 limit $7`,
			[
				filter.vendorNo ?? null,
				filter.itemNo ?? null,
				filter.customerNo ?? null,
				filter.madeBy ?? null,
				filter.kind ?? null,
				filter.status ?? null,
				filter.limit ?? 200
			]
		)
	);
	return rows.map((r) => ({
		id: Number(r.id),
		kind: r.kind,
		subject: r.subject,
		subjectId: r.subject_id,
		itemNo: r.item_no,
		family: r.family,
		customerNo: r.customer_no,
		vendorNo: r.vendor_no,
		promisedDate: r.promised_date,
		promisedValue: r.promised_value,
		basis: r.basis,
		basisDetail: r.basis_detail,
		confidence: r.confidence,
		confidenceBasis: r.confidence_basis,
		asOf: r.as_of,
		madeBy: Number(r.made_by),
		makerName: r.maker_name,
		makerKind: r.maker_kind,
		runKey: r.run_key,
		status: r.status,
		actualDate: r.actual_date,
		actualValue: r.actual_value,
		settledOn: r.settled_on,
		outcomeSource: r.outcome_source,
		outcomeDetail: r.outcome_detail,
		daysOut: r.days_out,
		valueOut: r.value_out,
		onTime: r.on_time,
		counted: r.counted === true
	}));
}

/**
 * The calibration line for one vendor, worst record first, so a buyer reads
 * the basis that is hurting them before the one that is fine.
 */
export async function getVendorPromiseRecord(
	db: Db,
	userId: number,
	vendorNo: string
): Promise<VendorPromiseRecord[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.sql<{
			vendor_no: string;
			vendor_name: string;
			basis: VendorPromiseRecord['basis'];
			settled: number;
			on_time: number;
			on_time_share: number | null;
			median_days_out: number | null;
			p90_days_out: number | null;
			worst_days_out: number | null;
			bias_days: number | null;
			pad_days: number;
			enough: boolean;
			last_settled_on: string | null;
			verdict: VendorPromiseRecord['verdict'];
			line: string;
		}>`select * from nl.vendor_promise_record
		    where vendor_no = ${vendorNo}
		    order by pad_days desc, settled desc, basis`
	);
	return rows.map(toVendorRecord);
}

/** The same line for every vendor with a record, biggest correction first. */
export async function getVendorPromiseRecords(
	db: Db,
	userId: number,
	limit = 50
): Promise<VendorPromiseRecord[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.sql<Parameters<typeof toVendorRecord>[0]>`
			select * from nl.vendor_promise_record
			order by pad_days desc, settled desc, vendor_no, basis
			limit ${limit}`
	);
	return rows.map(toVendorRecord);
}

function toVendorRecord(r: {
	vendor_no: string;
	vendor_name: string;
	basis: VendorPromiseRecord['basis'];
	settled: number;
	on_time: number;
	on_time_share: number | null;
	median_days_out: number | null;
	p90_days_out: number | null;
	worst_days_out: number | null;
	bias_days: number | null;
	pad_days: number;
	enough: boolean;
	last_settled_on: string | null;
	verdict: VendorPromiseRecord['verdict'];
	line: string;
}): VendorPromiseRecord {
	return {
		vendorNo: r.vendor_no,
		vendorName: r.vendor_name,
		basis: r.basis,
		settled: r.settled,
		onTime: r.on_time,
		onTimeShare: r.on_time_share,
		medianDaysOut: r.median_days_out,
		p90DaysOut: r.p90_days_out,
		worstDaysOut: r.worst_days_out,
		biasDays: r.bias_days,
		padDays: r.pad_days,
		enough: r.enough,
		lastSettledOn: r.last_settled_on,
		verdict: r.verdict,
		line: r.line
	};
}

/** The record behind one part's date: which vendor and basis it rests on, and how that has gone. */
export async function getPartPromiseRecord(
	db: Db,
	userId: number,
	itemNo: string
): Promise<PartPromiseRecord | null> {
	const rows = await db.asUser(userId, (tx) =>
		tx.sql<{
			item_no: string;
			family: string;
			vendor_no: string | null;
			promise_basis: PartPromiseRecord['promiseBasis'];
			promise_days: number;
			pad_days: number | null;
			correction_level: PartPromiseRecord['correctionLevel'] | null;
			settled: number | null;
			on_time: number | null;
			on_time_share: number | null;
			median_days_out: number | null;
			p90_days_out: number | null;
			enough: boolean | null;
			correction_detail: string | null;
		}>`select * from nl.part_promise_record where item_no = ${itemNo}`
	);
	const r = rows[0];
	if (!r) return null;
	return {
		itemNo: r.item_no,
		family: r.family,
		vendorNo: r.vendor_no,
		promiseBasis: r.promise_basis,
		promiseDays: r.promise_days,
		padDays: r.pad_days ?? 0,
		correctionLevel: r.correction_level ?? 'none',
		settled: r.settled ?? 0,
		onTime: r.on_time ?? 0,
		onTimeShare: r.on_time_share,
		medianDaysOut: r.median_days_out,
		p90DaysOut: r.p90_days_out,
		enough: r.enough === true,
		correctionDetail: r.correction_detail ?? ''
	};
}

/**
 * Per person and per agent. An agent is a row in `nl.users` (0031), so this
 * one view covers both in one vocabulary.
 */
export async function getMakerPromiseRecord(
	db: Db,
	userId: number,
	filter: { madeBy?: number | null; kind?: PromiseKind | null } = {}
): Promise<MakerPromiseRecord[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.query<{
			made_by: number;
			maker_name: string;
			maker_kind: string;
			kind: PromiseKind;
			basis: MakerPromiseRecord['basis'];
			settled: number;
			on_time: number;
			on_time_share: number;
			stated_confidence: number;
			confidence_gap: number;
			median_days_out: number | null;
			last_settled_on: string | null;
		}>(
			`select * from nl.maker_promise_record m
			 where ($1::int is null or m.made_by = $1)
			   and ($2::text is null or m.kind = $2)
			 order by m.settled desc, m.made_by, m.basis`,
			[filter.madeBy ?? null, filter.kind ?? null]
		)
	);
	return rows.map((r) => ({
		madeBy: Number(r.made_by),
		makerName: r.maker_name,
		makerKind: r.maker_kind,
		kind: r.kind,
		basis: r.basis,
		settled: r.settled,
		onTime: r.on_time,
		onTimeShare: r.on_time_share,
		statedConfidence: r.stated_confidence,
		confidenceGap: r.confidence_gap,
		medianDaysOut: r.median_days_out,
		lastSettledOn: r.last_settled_on
	}));
}

// ---------------------------------------------------------------------------
// Alternatives
// ---------------------------------------------------------------------------

export interface AlternativeOption {
	/** The thing's own id where it has one: a vendor number, a sheet id. */
	ref?: string | null;
	label: string;
	value?: number | null;
	/** What `value` is, in the disclosure vocabulary: `unit_cost`, `vendor_lead_time`. */
	factKind?: string | null;
	valueDate?: string | null;
	chosen?: boolean;
	/** Never optional. An option with no reason answers nothing later. */
	reason: string;
}

export interface AlternativesInput {
	runKey: string;
	agent: string;
	workKind?: string;
	/** What the choice was between: `vendor`, `price`, `quantity`, `date`. */
	choice: string;
	options: AlternativeOption[];
	requestId: string;
}

/**
 * Record a whole set of options at once, because the set is the unit that
 * means anything. The database refuses a set of one and a set with no chosen
 * option.
 */
export async function recordAlternatives(
	tx: Tx,
	input: AlternativesInput
): Promise<{ options: number; recorded: number }> {
	const payload = input.options.map((o) => ({
		ref: o.ref ?? '',
		label: o.label,
		value: o.value ?? null,
		fact_kind: o.factKind ?? '',
		value_date: o.valueDate ?? null,
		chosen: o.chosen === true,
		reason: o.reason
	}));
	const [row] = await tx.sql<WriteRow<{ options: number; recorded: number }>>`
		select nl.record_alternatives(${input.runKey}, ${input.agent}, ${input.workKind ?? ''},
		                              ${input.choice}, ${JSON.stringify(payload)}::jsonb,
		                              ${input.requestId}) as result`;
	return { options: Number(row.result.options), recorded: Number(row.result.recorded) };
}

/** The same thing, in its own transaction, as one person or agent. */
export async function recordAlternativesAs(db: Db, userId: number, input: AlternativesInput) {
	return guarded(() => db.asUser(userId, (tx) => recordAlternatives(tx, input)));
}

/**
 * What was also considered on one run, with disclosure already applied by the
 * database: a figure this reader may not be shown is absent from the payload
 * rather than nulled in place, and `valueWithheld` says one was there.
 */
export async function getAlsoConsidered(
	db: Db,
	userId: number,
	runKey: string
): Promise<ConsideredChoice[]> {
	const [row] = await db.asUser(userId, (tx) =>
		tx.sql<{
			payload: {
				choice: string;
				agent: string;
				work_kind: string;
				options: {
					ref?: string;
					label: string;
					value?: number;
					value_withheld?: boolean;
					fact_kind?: string;
					value_date?: string;
					chosen?: boolean;
					reason: string;
				}[];
			}[];
		}>`select nl.also_considered(${runKey}) as payload`
	);
	return (row?.payload ?? []).map((c) => ({
		choice: c.choice,
		agent: c.agent,
		workKind: c.work_kind,
		options: c.options.map(
			(o): ConsideredOption => ({
				ref: o.ref ?? null,
				label: o.label,
				value: o.value ?? null,
				valueWithheld: o.value_withheld === true,
				factKind: o.fact_kind ?? null,
				valueDate: o.value_date ?? null,
				chosen: o.chosen === true,
				reason: o.reason
			})
		)
	}));
}

/**
 * Keys whose stored calibration differs from a fresh computation. Should
 * always be empty. Runs as the schema owner, like the nightly job does: the
 * drift check is maintenance, not something a signed-in person asks for.
 */
export async function getCalibrationDrift(
	db: Db
): Promise<
	{
		vendorNo: string;
		family: string;
		kind: string;
		basis: string;
		storedSettled: number | null;
		liveSettled: number | null;
		storedPad: number | null;
		livePad: number | null;
	}[]
> {
	const rows = await db.asSystem((tx) =>
		tx.sql<{
			vendor_no: string;
			family: string;
			kind: string;
			basis: string;
			stored_settled: number | null;
			live_settled: number | null;
			stored_pad: number | null;
			live_pad: number | null;
		}>`select * from nl.calibration_drift()`
	);
	return rows.map((r) => ({
		vendorNo: r.vendor_no,
		family: r.family,
		kind: r.kind,
		basis: r.basis,
		storedSettled: r.stored_settled,
		liveSettled: r.live_settled,
		storedPad: r.stored_pad,
		livePad: r.live_pad
	}));
}
