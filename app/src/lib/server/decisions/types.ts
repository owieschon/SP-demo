// What a decision record is, in the shapes a page reads.
//
// The rules all live in migration 0039. Nothing in this folder works a
// confidence, a correction or an outcome out in JavaScript: it calls the
// database and renames the columns, so a page, the desk agent and the
// assistant cannot answer "how good is this promise" three different ways.

/** What kind of figure was promised. */
export type PromiseKind = 'date' | 'price' | 'coverage';

/**
 * Which rule produced the figure. The date words come from
 * `nl.promise_lead_days()` in 0032 plus `exception` from `nl.lead_time_for()`
 * and `calibrated` from 0039; the price words come from
 * `nl.price_quote_for()`. `nl.promise_bases()` is the list the database
 * enforces.
 */
export type PromiseBasisWord =
	| 'observed'
	| 'quoted'
	| 'item card'
	| 'vendor default'
	| 'default'
	| 'exception'
	| 'calibrated'
	| 'rolled'
	| 'agreement'
	| 'held sheet'
	| 'last paid'
	| 'sheet'
	| 'group discount'
	| 'list'
	| 'cover target'
	| 'reorder point'
	| 'judgement';

/** Where the confidence figure came from. Only `measured` is evidence. */
export type ConfidenceBasis = 'measured' | 'policy' | 'vendor word' | 'house default' | 'person';

/** How a promise ended. `void` means nothing was ever decided and never will be. */
export type PromiseOutcome = 'kept' | 'missed' | 'void';

/** A promise joined forward to what happened, one row of `nl.promise_record`. */
export interface PromiseRecord {
	id: number;
	kind: PromiseKind;
	subject: string;
	subjectId: string;
	itemNo: string | null;
	family: string | null;
	customerNo: string | null;
	vendorNo: string | null;
	promisedDate: string | null;
	promisedValue: number | null;
	basis: PromiseBasisWord;
	basisDetail: string;
	confidence: number;
	confidenceBasis: ConfidenceBasis;
	asOf: string;
	madeBy: number;
	makerName: string | null;
	makerKind: string | null;
	runKey: string | null;
	/** `open` until somebody or something settled it. */
	status: PromiseOutcome | 'open';
	actualDate: string | null;
	actualValue: number | null;
	settledOn: string | null;
	outcomeSource: string | null;
	outcomeDetail: string | null;
	/** Signed: positive is late, negative is early. Null while open. */
	daysOut: number | null;
	valueOut: number | null;
	/** Null while open or void, because a rate over an unanswered promise is invented. */
	onTime: boolean | null;
	counted: boolean;
}

/** The calibration line a vendor page prints, one row of `nl.vendor_promise_record`. */
export interface VendorPromiseRecord {
	vendorNo: string;
	vendorName: string;
	basis: PromiseBasisWord;
	settled: number;
	onTime: number;
	onTimeShare: number | null;
	medianDaysOut: number | null;
	p90DaysOut: number | null;
	worstDaysOut: number | null;
	biasDays: number | null;
	/** The correction this record implies, in days. Zero when the basis is already honest. */
	padDays: number;
	/** False while there is not enough history for the correction to be applied. */
	enough: boolean;
	lastSettledOn: string | null;
	verdict: 'over promising' | 'under promising' | 'about right' | 'not enough yet';
	/** The whole sentence, assembled by the database so every screen says it the same way. */
	line: string;
}

/** The record behind one part's date, one row of `nl.part_promise_record`. */
export interface PartPromiseRecord {
	itemNo: string;
	family: string;
	vendorNo: string | null;
	/** The basis before any correction. */
	promiseBasis: PromiseBasisWord;
	/** The days before any correction. */
	promiseDays: number;
	padDays: number;
	/** Which record answered: `family`, `vendor` or `none`. */
	correctionLevel: 'family' | 'vendor' | 'none';
	settled: number;
	onTime: number;
	onTimeShare: number | null;
	medianDaysOut: number | null;
	p90DaysOut: number | null;
	enough: boolean;
	correctionDetail: string;
}

/** Per person or agent: did their promises hold, and did the confidence they stated hold. */
export interface MakerPromiseRecord {
	madeBy: number;
	makerName: string;
	makerKind: string;
	kind: PromiseKind;
	basis: PromiseBasisWord;
	settled: number;
	onTime: number;
	onTimeShare: number;
	statedConfidence: number;
	/** Measured share minus stated confidence. Negative means they claimed more than they did. */
	confidenceGap: number;
	medianDaysOut: number | null;
	lastSettledOn: string | null;
}

/** The date to promise for a part, with its basis and confidence attached. */
export interface DatePromise {
	itemNo: string;
	promisedDate: string;
	leadDays: number;
	basis: PromiseBasisWord;
	basisDetail: string;
	confidence: number;
	confidenceBasis: ConfidenceBasis;
	canPromise: boolean;
	vendorNo: string | null;
	correctionDays: number;
	correctionLevel: 'family' | 'vendor' | 'none';
}

/** One option that was considered. `value` is absent when disclosure withheld it. */
export interface ConsideredOption {
	ref: string | null;
	label: string;
	value: number | null;
	/** True when there was a figure but this reader may not be shown it. */
	valueWithheld: boolean;
	factKind: string | null;
	valueDate: string | null;
	chosen: boolean;
	reason: string;
}

/** One choice an agent made, with everything it weighed. */
export interface ConsideredChoice {
	choice: string;
	agent: string;
	workKind: string;
	options: ConsideredOption[];
}
