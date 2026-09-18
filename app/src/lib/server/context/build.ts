// The context build: what a schedule calls.
//
// It is a mill, and it runs in the order the work matters:
//
//   1. register whatever the stores have that we have not seen (adapters);
//   2. read the coverage list to find the worst gaps;
//   3. explore for the subjects that matter most, worst gap first;
//   4. promote what the rules allow;
//   5. recompile the bundles whose content actually changed.
//
// Step 3 is what makes the coverage list a WORK LIST rather than a report. It
// is also the step with a budget on it, because reading every document about
// every account every night is not a build, it is a bill.
//
// Nothing here sends anything and nothing here decides a conflict. A
// disagreement the rules will not settle comes out as a number in the
// summary and a row on the conflicts screen.
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/types.ts';
import type { SubjectKind } from '$lib/context/types';
import { exploreIn } from './explore.ts';
import { NO_PROSE_MODEL, type ProseModel } from './extract.ts';
import { registerSources, type AdapterResult } from './sources.ts';
import { compileIn, promoteIn } from './write.ts';

export interface ContextBuildOptions {
	/** How many subjects to explore for. The budget. */
	subjects?: number;
	/** Documents per subject. The other half of the budget. */
	documentsPerSubject?: number;
	/** Stage two of extraction. The default needs no key and finds nothing. */
	model?: ProseModel;
	/** Skip the adapters, for a run that only wants to promote and compile. */
	registerFirst?: boolean;
}

export interface ContextBuildSummary {
	startedAt: string;
	ms: number;
	adapters: AdapterResult[];
	/** The gaps it chose to chase, worst coverage first. */
	chased: { subjectKind: SubjectKind; attribute: string; subjects: number }[];
	explored: number;
	claimsWritten: number;
	unparsed: number;
	failedValidation: number;
	inventedSpansRefused: number;
	promoted: number;
	conflictsRaised: number;
	heldForAPerson: number;
	bundlesChanged: number;
	bundlesUnchanged: number;
}

interface GapTarget {
	subjectKind: SubjectKind;
	attribute: string;
	subjectId: string;
}

/**
 * Run the mill. One transaction, because a half-registered source with claims
 * against it is worse than no run at all, and because the whole thing is
 * short: the budget is what keeps it short.
 */
export async function runContextBuild(
	db: Db,
	userId: number,
	options: ContextBuildOptions = {}
): Promise<ContextBuildSummary> {
	const started = Date.now();
	const subjectBudget = options.subjects ?? 12;
	const documentBudget = options.documentsPerSubject ?? 25;
	const model = options.model ?? NO_PROSE_MODEL;
	const requestId = `ctx-build-${randomUUID()}`;

	return db.asUser(userId, async (tx) => {
		const summary: ContextBuildSummary = {
			startedAt: new Date(started).toISOString(),
			ms: 0,
			adapters: [],
			chased: [],
			explored: 0,
			claimsWritten: 0,
			unparsed: 0,
			failedValidation: 0,
			inventedSpansRefused: 0,
			promoted: 0,
			conflictsRaised: 0,
			heldForAPerson: 0,
			bundlesChanged: 0,
			bundlesUnchanged: 0
		};

		if (options.registerFirst !== false) {
			summary.adapters = await registerSources(tx);
		}

		// The worst-covered attributes first, and for each one the subjects
		// that matter most and have no fresh answer. That ordering is the
		// whole of the prioritisation: it needs no separate score.
		const gaps = await tx.query<{ subject_kind: SubjectKind; attribute: string; missing: number }>(
			`select subject_kind, attribute, missing
			 from nl.context_coverage(200)
			 where missing > 0
			 order by coverage_pct, missing desc
			 limit 12`
		);

		const targets: GapTarget[] = [];
		for (const gap of gaps) {
			if (targets.length >= subjectBudget) break;
			const subjects = await tx.query<{ subject_id: string }>(
				'select subject_id from nl.context_gaps($1, $2, $3)',
				[gap.subject_kind, gap.attribute, Math.max(1, Math.ceil(subjectBudget / gaps.length))]
			);
			if (subjects.length === 0) continue;
			summary.chased.push({
				subjectKind: gap.subject_kind,
				attribute: gap.attribute,
				subjects: subjects.length
			});
			for (const subject of subjects) {
				if (targets.length >= subjectBudget) break;
				targets.push({
					subjectKind: gap.subject_kind,
					attribute: gap.attribute,
					subjectId: subject.subject_id
				});
			}
		}

		for (const target of targets) {
			const report = await exploreIn(
				tx,
				{ kind: target.subjectKind, id: target.subjectId },
				{ attribute: target.attribute, limit: documentBudget, model }
			);
			summary.explored += 1;
			summary.claimsWritten += report.claimsWritten;
			summary.unparsed += report.unparsed;
			summary.failedValidation += report.failedValidation;
			summary.inventedSpansRefused += report.inventedSpansRefused;
		}

		const promotion = await promoteIn(tx, {}, requestId);
		summary.promoted = promotion.promoted;
		summary.conflictsRaised = promotion.conflicts_raised;
		summary.heldForAPerson = promotion.held_for_a_person;

		// Recompile only the subjects something could have changed for: the
		// ones just explored, plus anything whose fact moved today. Compiling
		// the whole book would be minutes of work for bundles nobody reads.
		const toCompile = await tx.query<{ subject_kind: SubjectKind; subject_id: string }>(
			`select distinct f.subject_kind, f.subject_id
			 from nl.facts f
			 where f.status = 'current'
			   and (f.updated_at > now() - interval '1 hour'
			        or f.stale_after between nl.today() - 7 and nl.today() + 7)
			 union
			 select distinct c.subject_kind, c.subject_id
			 from nl.claims c
			 where c.subject_id is not null and c.captured_at > now() - interval '1 hour'`
		);
		for (const subject of toCompile) {
			const result = await compileIn(tx, { kind: subject.subject_kind, id: subject.subject_id });
			summary.bundlesChanged += result.changed;
			summary.bundlesUnchanged += result.unchanged;
		}

		summary.ms = Date.now() - started;
		return summary;
	});
}

/**
 * The SQL-only half, for a schedule that would rather call one function than
 * an endpoint: promote and recompile, no exploring. This is what
 * nl.context_build() does, and it is here so the two entry points are
 * obviously the same thing at different depths.
 */
export async function runSqlContextBuild(
	db: Db,
	userId: number,
	subjectLimit = 25
): Promise<{ subjects: number; promoted: number; conflicts_raised: number; bundles_changed: number }> {
	return db.asUser(userId, async (tx) => {
		const [row] = await tx.query<{
			result: { subjects: number; promoted: number; conflicts_raised: number; bundles_changed: number };
		}>('select nl.context_build($1, $2) as result', [
			subjectLimit,
			`ctx-sql-build-${randomUUID()}`.slice(0, 100)
		]);
		return row.result;
	});
}
