/*
  The shapes the overview hands to its page, its components and its tests.
  One file, so the server and the markup cannot drift.

  Two house rules are in the types rather than in a review comment, because a
  type is the only kind of reminder that still works at midnight.

  1. A Figure has no optional `compare`. A figure with nothing to compare
     against is not allowed on this page, so there is no way to build one.
  2. A Figure has an `href`. Every number on this page is a link, so a number
     without one cannot be expressed.
*/

/** What a figure is counted in. The components format it; the server does not. */
export type Unit = 'money' | 'count' | 'percent' | 'days' | 'hours';

/** One number, with everything that makes it arguable and the way to prove it. */
export interface Figure {
	/** Stable across loads, so a test can name one. */
	id: string;
	label: string;
	value: number;
	unit: Unit;
	/** What it is measured against, in words. Required. */
	compare: string;
	/** Where it came from, in a person's words. */
	source: string;
	/** The screen that proves it. Required. */
	href: string;
	/** What the link says. */
	hrefLabel: string;
	tone: 'plain' | 'warn' | 'danger';
	/** The tone as a word, so colour is never the only signal. */
	toneWord?: string;
}

/** A month on the one chart this page is allowed. */
export interface MonthPoint {
	/** First day of the month, ISO. */
	month: string;
	revenue: number;
	/** The same month a year earlier: the chart's reference line. */
	priorRevenue: number;
	/** True for the month we are still in, which is not a fair comparison. */
	partial: boolean;
}

/** One named leak, as it appears on the overview. */
export interface LeakSummary {
	/** The leak's id in a URL. */
	id: string;
	/** What it is, as a noun phrase. */
	name: string;
	/** The question it answers, one line. */
	question: string;
	value: number;
	unit: Unit;
	/** How many things are behind it. Zero means there is nothing to recover. */
	count: number;
	/** The figure in words: what it counts and over what window. */
	detail: string;
	/** What to say when count is zero. Not an empty table. */
	nothing: string;
	href: string;
	tone: 'plain' | 'warn' | 'danger';
}

export interface MoneySection {
	today: string;
	/** The window the top figures cover, named so nobody has to guess. */
	periodLabel: string;
	priorPeriodLabel: string;
	figures: Figure[];
	months: MonthPoint[];
	leaks: LeakSummary[];
	/** False when this reader's disclosure level does not allow cost or margin. */
	showsMargin: boolean;
}

export interface PromiseSection {
	today: string;
	figures: Figure[];
	/** Accounts whose recent windows did not hold, worst first. */
	slipping: SlippingAccount[];
}

export interface SlippingAccount {
	customerNo: string;
	customerName: string;
	windows: number;
	pushed: number;
	broken: number;
	committed: number;
	delivered: number;
	lastClosedOn: string;
	href: string;
	/** The account's own record. */
	accountHref: string;
}

/** One agent and one kind of work, exactly as the harness board reports it. */
export interface AgentRow {
	agent: string;
	workKind: string;
	label: string;
	level: string;
	levelLabel: string;
	levelMeaning: string;
	reviewer: string;
	paused: boolean;
	pausedReason: string | null;
	runs: number;
	waiting: number;
	reviewed: number;
	/** Null until somebody has decided one, which is not the same as zero. */
	approvalRate: number | null;
	editRate: number | null;
	refusals: number;
	actedAlone: number;
	undone: number;
	lastRunAt: string | null;
	verdict: string;
	href: string;
	refusalsHref: string;
	actedHref: string;
}

/** One line of the value ledger: something an agent did, and how to see it. */
export interface ValueLine {
	id: string;
	/** What happened, in the words a person would use. */
	what: string;
	count: number;
	/** How it is counted, so nobody reads it as a saving. */
	basis: string;
	href: string;
}

export interface AgentSection {
	rows: AgentRow[];
	figures: Figure[];
	/** What the agents did in the last seven days, each line pointing at the rows behind it. */
	value: ValueLine[];
	/** Said out loud on the page: what the ledger deliberately does not claim. */
	valueCaveat: string;
	/** The run log is built from whichever sources this database has. */
	sources: Record<string, boolean>;
}

export interface RiskSection {
	today: string;
	figures: Figure[];
}

/** One row of evidence: the thing that produced a number. */
export interface EvidenceRow {
	/** Unique in its list. An invoice number can appear twice, one line each. */
	key: string;
	/** What to show in the first column: an invoice number, a run key, a date. */
	ref: string;
	on: string;
	label: string;
	/** Two or three numbers, already named, so the table needs no legend. */
	numbers: { label: string; value: number; unit: Unit }[];
	/** Where the thing itself lives, when it has a page. */
	href: string | null;
	hrefLabel: string | null;
}
