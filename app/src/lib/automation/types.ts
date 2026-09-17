// What the automation pages receive from the server.
import type { Rule, TriggerKey } from './catalog';

/** How one run went. */
export interface RunSummary {
	id: number;
	via: 'ui' | 'schedule';
	runBy: string;
	startedAt: string;
	finishedAt: string | null;
	matched: number | null;
	fired: number | null;
	skipped: number | null;
	error: string | null;
}

/** A rule as the list page shows it. */
export interface RuleListItem {
	id: number;
	name: string;
	description: string;
	trigger: TriggerKey;
	triggerLabel: string;
	/** The whole rule as one plain-English sentence. */
	sentence: string;
	enabled: boolean;
	ownerId: number;
	ownerName: string;
	canEdit: boolean;
	lastRun: RunSummary | null;
	firingCount: number;
}

/** Something a rule wrote. */
export interface FiringItem {
	id: number;
	subjectKey: string;
	firedAt: string;
	runId: number;
	kind: 'next_step' | 'note' | null;
	/** The next step's title or the note's text. */
	text: string | null;
	customerNo: string | null;
	customerName: string | null;
	commitmentId: number | null;
	assigneeName: string | null;
	dueOn: string | null;
}

/** A saved rule, for the editor. */
export interface RuleDetail {
	id: number;
	rule: Rule;
	ownerId: number;
	ownerName: string;
	/** Row version, sent back on save. */
	updatedAt: string;
	canEdit: boolean;
	firingCount: number;
	runs: RunSummary[];
	firings: FiringItem[];
}

/** A person a rule can name. */
export interface PersonOption {
	id: number;
	name: string;
}

/** One match in a dry run. */
export interface TestMatch {
	subjectKey: string;
	customerNo: string;
	customerName: string;
	commitmentId: number | null;
	headline: string;
	/** Field key to value, for the fields the table shows. */
	values: Record<string, number | null>;
	/** What the action would write for this match. */
	text: string;
	/** Who a next step would go to. */
	assigneeName: string | null;
	alreadyFired: boolean;
}

export interface TestResult {
	total: number;
	alreadyFired: number;
	/** Field keys shown as columns, in order. */
	fields: string[];
	matches: TestMatch[];
}

/** What "Run now" and the schedule report back. */
export interface RunResult {
	runId: number;
	matched: number;
	fired: number;
	skipped: number;
	error: string | null;
}

/**
 * Every answer from the editor's form actions (lib/server/automation/actions.ts)
 * has this shape, so the page shows each one in the same place.
 */
export interface EditorAnswer {
	from: 'test' | 'save' | 'run';
	message: string;
	failed: boolean;
	/** The rule changed since the page loaded it. */
	conflict?: boolean;
	/** Problem text by path in the rule, e.g. "conditions.0.value". */
	issues?: Record<string, string>;
	test?: TestResult;
	run?: RunResult;
}
