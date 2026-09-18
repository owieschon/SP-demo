// Building a trail: the two rules, in code.
//
// Rule one. A step never holds anything the disclosure policy would forbid
// its reader from seeing. The trail goes through the SAME check as a draft
// reply (../desk/policy.ts, not a copy of it), against the run's reader and
// the account the run is about. A step that fails it keeps its label and its
// reason and loses its detail, and says so. The database drops the detail
// again on the way in, so this is belt and braces on purpose: a trail that
// leaked what a reply could not would make the whole disclosure story
// worthless, and the trail is the part nobody reads carefully.
//
// There are TWO readers, though, and this file can only answer for one of
// them. The check here is against the level the run's own output was drafted
// at, which is the mailbox's. The other reader is the person who opens the
// trail afterwards, and their disclosure grant (migration 0031) is a
// different question: one trail is read by many people. This file cannot
// answer that one, because a trail is written once and nobody knows yet who
// will read it. What it does instead is record on every step which KINDS of
// fact its detail rests on, so that ./read.ts can answer it at read time
// through nl.may_see. That is the whole reason fact_kinds exists.
//
// The amount rule applies here too, and it is the one that bites: every
// dollar figure in a step has to trace back to a fact the step carries. So a
// step that names money attaches the facts that money came from, and a step
// that only counts rows does not name money at all.
//
// Rule two. A refusal is a step, with a rule reference and the rule's own
// sentence on it, never a silence. `refusal()` will not build one without a
// rule, and the database will not store one either.
import type { Disclosure, Fact, FactKind } from '$lib/desk/types';
import { RULES, type RuleKey, type StepKind } from '$lib/agentruns/types';
import { checkDraft } from '../desk/policy.ts';
import type { Tx } from '../db/types.ts';
import type { StepInput } from './writes.ts';

/** A step before the disclosure check: the facts are what the check reads. */
export interface DraftStep {
	kind: StepKind;
	label: string;
	tool?: string | null;
	args?: Record<string, unknown> | null;
	result?: string;
	rows?: number | null;
	ms?: number | null;
	rule?: RuleKey | null;
	/** The facts the step's detail rests on, for the disclosure check. */
	facts?: Fact[];
}

export interface TrailReader {
	/** How far this trail may go: the mailbox's own disclosure level. */
	reader: Disclosure;
	/** Whose facts the run is about: a customer number or a vendor number. */
	subject: string | null;
}

/**
 * What the disclosure check reads of a step: its label as the subject line
 * and everything else as the body. If the policy would refuse a reply made
 * of this, the step is withheld.
 */
function stepText(step: DraftStep): string {
	const parts = [step.result ?? ''];
	if (step.args) parts.push(JSON.stringify(step.args));
	if (step.rule) parts.push(RULES[step.rule].note);
	return parts.filter(Boolean).join('\n');
}

/**
 * The kinds of fact a step's detail rests on, deduplicated and in a stable
 * order. This is the step's own declaration of what is in it, and it is what
 * the READ-time check reads: a trail is written once against the mailbox's
 * level and then read by people whose own disclosure grants differ, and only
 * the reader knows who is reading. See ./read.ts.
 */
function factKindsOf(step: DraftStep): FactKind[] {
	return [...new Set((step.facts ?? []).map((fact) => fact.kind))].sort();
}

/** One step, checked against the policy and turned into a row. */
export function checkStep(step: DraftStep, who: TrailReader): StepInput {
	const verdict = checkDraft({
		level: who.reader,
		subject: who.subject,
		facts: step.facts ?? [],
		subjectLine: step.label,
		body: stepText(step)
	});

	const base: StepInput = {
		kind: step.kind,
		label: step.label,
		tool: step.tool ?? null,
		rows: step.rows ?? null,
		ms: step.ms ?? null,
		rule: step.rule ? RULES[step.rule].id : null,
		rule_note: step.rule ? RULES[step.rule].note : '',
		// Kept even when the step is withheld below: "there was a step here
		// about unit cost and you may not see it" is the visible withholding,
		// and a step that dropped its kinds could never be explained.
		fact_kinds: factKindsOf(step)
	};

	if (verdict.ok) {
		return { ...base, args: step.args ?? null, result: step.result ?? '' };
	}

	// Withheld. The label survives, because "there was a step here and you
	// may not see it" is information; the detail does not.
	return {
		...base,
		args: null,
		result: '',
		withheld: true,
		withheld_reason: `${verdict.reasons[0]} ${RULES.trailDisclosure.note}`.slice(0, 500)
	};
}

/**
 * The steps of one run, in the order they happened.
 *
 * Nothing here talks to the database: a caller builds the trail, then writes
 * it. That keeps the recording out of the agent's own transaction, so a
 * trail can never be the reason a run failed.
 */
export class Trail {
	private readonly steps: DraftStep[] = [];

	constructor(private readonly who: TrailReader) {}

	/** Something the agent read. */
	read(label: string, result = '', facts?: Fact[]): this {
		this.steps.push({ kind: 'read', label, result, facts });
		return this;
	}

	/** A tool call: what it was asked, and what came back in summary. */
	tool(
		name: string,
		args: Record<string, unknown> | null,
		result: string,
		extra: { rows?: number | null; ms?: number | null; facts?: Fact[] } = {}
	): this {
		this.steps.push({
			kind: 'tool',
			label: name,
			tool: name,
			args,
			result,
			rows: extra.rows ?? null,
			ms: extra.ms ?? null,
			facts: extra.facts
		});
		return this;
	}

	/** Something it worked out. */
	decide(label: string, result = '', facts?: Fact[]): this {
		this.steps.push({ kind: 'decision', label, result, facts });
		return this;
	}

	/** Something it would not do, and the rule that stopped it. */
	refuse(label: string, rule: RuleKey, result = ''): this {
		this.steps.push({ kind: 'refusal', label, rule, result });
		return this;
	}

	/** Something it made. */
	produce(label: string, result = '', facts?: Fact[]): this {
		this.steps.push({ kind: 'output', label, result, facts });
		return this;
	}

	note(label: string, result = ''): this {
		this.steps.push({ kind: 'note', label, result });
		return this;
	}

	get length(): number {
		return this.steps.length;
	}

	get refusals(): number {
		return this.steps.filter((step) => step.kind === 'refusal').length;
	}

	/** Every step, checked and ready to write. */
	rows(): StepInput[] {
		return this.steps.map((step) => checkStep(step, this.who));
	}
}

// ---------------------------------------------------------------------------
// What else is in this database
// ---------------------------------------------------------------------------

export interface TrailCapabilities {
	/** True when the context engine's versioned bundles are present. */
	contextBundles: boolean;
	/** The bundle version a run reads today, when there is one. */
	bundleVersion: string | null;
}

/**
 * Feature-detect the context engine rather than assuming it.
 *
 * The context work is on another branch. If it has landed its versioned
 * bundles, a run records which version it read, because "the agent said that
 * under bundle 7" is the difference between a record and an anecdote. Until
 * then the column stays null and nothing here fails. Both table names are
 * tried, because the branch has not settled on one.
 */
export async function readTrailCapabilities(tx: Tx): Promise<TrailCapabilities> {
	const [found] = await tx.sql<{ table_name: string | null }>`
		select coalesce(
			(select 'nl.context_bundles' where pg_catalog.to_regclass('nl.context_bundles') is not null),
			(select 'nl.context_bundle_versions' where pg_catalog.to_regclass('nl.context_bundle_versions') is not null)
		) as table_name`;
	const table = found?.table_name ?? null;
	if (!table) return { contextBundles: false, bundleVersion: null };

	// A table is there, but its column names are not settled. Ask the catalog
	// for a version-shaped column and read the newest value through it.
	const [column] = await tx.query<{ column_name: string }>(
		`select column_name from information_schema.columns
		 where table_schema = 'nl' and table_name = $1 and column_name in ('version', 'bundle_version')
		 order by column_name
		 limit 1`,
		[table.replace('nl.', '')]
	);
	if (!column) return { contextBundles: true, bundleVersion: null };

	try {
		const [row] = await tx.query<{ version: string | null }>(
			`select max(${column.column_name})::text as version from ${table}`
		);
		return { contextBundles: true, bundleVersion: row?.version ?? null };
	} catch {
		// A shape we did not expect is not a reason to fail a run.
		return { contextBundles: true, bundleVersion: null };
	}
}
