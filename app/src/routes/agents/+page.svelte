<script lang="ts">
	/*
	  /agents answers three questions and nothing else:

	    1. What did the agents do?          the feed, with the outcome of each run
	    2. What were they refused, and why? the named checks, most often first
	    3. Has any work earned more autonomy? the board, its numbers and its verdict

	  Everything on this page is a number somebody would change their mind
	  about. There is no chart: a bar of the same numbers would be prettier and
	  would not tell anyone anything they cannot read here.

	  The controls are policy, not work: a level, the brake, an undo, and a
	  verdict on a sampled action. The work itself happens without this page.
	*/
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import Page from '$lib/components/ui/Page.svelte';
	import Panel from '$lib/components/ui/Panel.svelte';
	import SkeletonRows from '$lib/components/ui/SkeletonRows.svelte';
	import SubmitButton from '$lib/components/ui/SubmitButton.svelte';
	import Tabs from '$lib/components/ui/Tabs.svelte';
	import { count, moment, percent } from '$lib/format';
	import { LEVEL_LABEL, LEVEL_MEANING, type BoardRow, type Level } from '$lib/server/harness/types';
	import { enhance } from '$app/forms';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	/** A form answer shows up beside the form that sent it and nowhere else. */
	function answer(from: string) {
		return form && 'from' in form && form.from === from ? form : null;
	}
	const levelMessage = $derived(answer('level'));
	const pauseMessage = $derived(answer('pause'));
	const undoMessage = $derived(answer('undo'));
	const sampleMessage = $derived(answer('sample'));

	const globalPause = $derived(data.pauses.find((p) => p.agent === 'all'));

	/** The board, grouped by agent, so a person reads one agent at a time. */
	const byAgent = $derived.by(() => {
		const groups = new Map<string, BoardRow[]>();
		for (const row of data.board) {
			const list = groups.get(row.agent) ?? [];
			list.push(row);
			groups.set(row.agent, list);
		}
		return [...groups.entries()];
	});

	const ready = $derived(data.board.filter((r) => r.qualifies));
	const acting = $derived(data.board.filter((r) => r.level === 'auto_review' || r.level === 'auto'));

	function rate(value: number | null): string {
		return value === null ? 'not yet' : percent(value);
	}

	function agentLabel(agent: string): string {
		return data.scopes.find((s) => s.id === agent)?.name ?? agent;
	}

	const OUTCOME_WORD: Record<string, string> = {
		ok: 'answered',
		needs_person: 'sent to a person',
		refused: 'refused',
		failed: 'failed',
		ignored: 'ignored',
		running: 'running'
	};
</script>

<Page
	title="Agents"
	subtitle="What the agents did, what they were refused, and what has earned more room."
>
	{#snippet actions()}
		<form method="POST" action="?/pause" use:enhance class="inline-form">
			<input type="hidden" name="agent" value="all" />
			<input type="hidden" name="paused" value={globalPause?.paused ? 'false' : 'true'} />
			<input type="hidden" name="reason" value={globalPause?.paused ? '' : 'Stopped from the agents page'} />
			<input type="hidden" name="requestId" value={`${data.requestId}-pause-all`} />
			<SubmitButton
				label={globalPause?.paused ? 'Start every agent' : 'Pause every agent'}
				workingLabel={globalPause?.paused ? 'Starting' : 'Pausing'}
				tone={globalPause?.paused ? 'primary' : 'danger'}
			/>
		</form>
	{/snippet}

	{#if globalPause?.paused}
		<p class="notice warn">
			Every agent is paused{globalPause.byName ? `, by ${globalPause.byName}` : ''}{globalPause.reason
				? `: ${globalPause.reason}`
				: ''}. They still read their mail and still draft. Nothing acts and nothing is sent.
		</p>
	{/if}
	{#if pauseMessage}
		<p class="notice" class:warn={'failed' in pauseMessage}>{pauseMessage.message}</p>
	{/if}

	<Tabs
		param="view"
		current={data.filters.view}
		label="What to show"
		tabs={[
			{ value: 'trust', label: 'Trust' },
			{ value: 'scope', label: 'What each agent may do' }
		]}
	/>

	{#if data.filters.view === 'scope'}
		<!-- The scope table from docs/agent-harness.md, as the page shows it. -->
		{#each data.scopes as scope (scope.id)}
			<Panel title={scope.name}>
				<p class="faint">{scope.purpose}</p>
				<div class="scope">
					<section>
						<h3>What wakes it</h3>
						<ul>{#each scope.wakes as line (line)}<li>{line}</li>{/each}</ul>
					</section>
					<section>
						<h3>What it may read</h3>
						<ul>{#each scope.reads as line (line)}<li>{line}</li>{/each}</ul>
					</section>
					<section>
						<h3>What it may write</h3>
						<ul>{#each scope.writes as line (line)}<li>{line}</li>{/each}</ul>
					</section>
					<section>
						<h3>What it may say</h3>
						<ul>{#each scope.says as line (line)}<li>{line}</li>{/each}</ul>
					</section>
					<section>
						<h3>What it must never do</h3>
						<ul>{#each scope.never as line (line)}<li>{line}</li>{/each}</ul>
					</section>
					<section>
						<h3>When it is unsure</h3>
						<p>{scope.unsure}</p>
						<h3>Who reviews it</h3>
						<p>{scope.reviewer}</p>
						<p class="faint mono">{scope.code}</p>
					</section>
				</div>
			</Panel>
		{/each}

		<Panel title="Which numbers are policy, and which are code">
			<p class="faint">
				A policy is something a person should be able to change without a deploy. Everything else is
				what the system is. The harness reads its policies from
				{data.policy.engine ? data.policy.name : data.policy.name}.
			</p>
			<div class="table-wrap">
				<table>
					<thead>
						<tr><th>Number</th><th>Kind</th><th>Where it lives</th><th>Why</th></tr>
					</thead>
					<tbody>
						{#each data.policyMap as entry (entry.name)}
							<tr>
								<td>{entry.name}</td>
								<td><span class="pill" class:strong={entry.kind === 'code'}>{entry.kind}</span></td>
								<td class="mono small">{entry.where}</td>
								<td class="faint">{entry.why}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</Panel>
	{:else}
		<!-- 3. Has any kind of work earned more autonomy? -->
		<Panel title="What each agent may do on its own">
			<p class="faint">
				A level is set per agent and per kind of work, because a quote reply and a stock question are
				not the same risk. {acting.length} of {data.board.length} kinds of work act without being asked
				first. {#if ready.length > 0}<strong
						>{ready.length} {ready.length === 1 ? 'is' : 'are'} ready for the next step.</strong
					>{/if}
			</p>
			{#if levelMessage}
				<p class="notice" class:warn={'failed' in levelMessage}>{levelMessage.message}</p>
			{/if}

			{#each byAgent as [agent, rows] (agent)}
				{@const paused = rows[0]?.paused}
				<section class="agent">
					<header class="agent-head">
						<h3>{agentLabel(agent)}</h3>
						{#if paused}
							<span class="pill warn">paused{rows[0].pausedByName ? `, by ${rows[0].pausedByName}` : ''}</span>
						{/if}
						{#if data.isAdmin && !globalPause?.paused}
							<form method="POST" action="?/pause" use:enhance class="inline-form">
								<input type="hidden" name="agent" value={agent} />
								<input type="hidden" name="paused" value={paused ? 'false' : 'true'} />
								<input type="hidden" name="requestId" value={`${data.requestId}-pause-${agent}`} />
								<SubmitButton
									label={paused ? 'Start' : 'Pause'}
									workingLabel={paused ? 'Starting' : 'Pausing'}
									tone={paused ? 'plain' : 'danger'}
									record={agentLabel(agent)}
								/>
							</form>
						{/if}
					</header>

					<div class="table-wrap">
						<table>
							<thead>
								<tr>
									<th>Work</th>
									<th>Level</th>
									<th class="num">Runs</th>
									<th class="num">Reviewed</th>
									<th class="num">Approved</th>
									<th class="num">Edited</th>
									<th class="num">Rejected</th>
									<th class="num">Edit size</th>
									<th class="num">Refused</th>
									<th class="num">To review</th>
									<th>Next step</th>
								</tr>
							</thead>
							<tbody>
								{#each rows as row (row.workKind)}
									<tr>
										<td>
											<strong>{row.label}</strong>
											<span class="faint small">{row.description}</span>
										</td>
										<td>
											<span class="pill" class:strong={row.level === 'auto' || row.level === 'auto_review'}>
												{LEVEL_LABEL[row.level as Level]}
											</span>
											<span class="faint small">{LEVEL_MEANING[row.level as Level]}</span>
											{#if row.level === 'auto_review'}
												<span class="faint small">{row.undoWindowMinutes} minutes to undo.</span>
											{/if}
											{#if row.level === 'auto'}
												<span class="faint small"
													>{percent(row.sampleRate)} reviewed afterwards{row.samplePassRate !== null
														? `, ${rate(row.samplePassRate)} of the sample good`
														: ''}.</span
												>
											{/if}
											<span class="faint small">
												{row.setByName ? `Set by ${row.setByName}` : 'Set by a rule'}, {moment(row.setAt)}.
											</span>
										</td>
										<td class="num">{count(row.runs)}</td>
										<td class="num">{count(row.reviewed)}</td>
										<td class="num">{rate(row.approvalRate)}</td>
										<td class="num">{rate(row.editRate)}</td>
										<td class="num">{rate(row.rejectionRate)}</td>
										<td class="num">
											{#if row.editsMeasured > 0}
												{count(row.avgEditChars ?? 0)} ch
											{:else}
												<span class="faint">not measured</span>
											{/if}
										</td>
										<td class="num">{count(row.refusals)}</td>
										<td class="num">
											{row.medianReviewMinutes === null
												? '-'
												: `${count(row.medianReviewMinutes)} min`}
										</td>
										<td>
											{#if row.nextLevel === null}
												<span class="faint">Top level.</span>
											{:else if row.qualifies}
												<p class="small">{row.verdict}</p>
												{#if data.isAdmin}
													<form method="POST" action="?/level" use:enhance class="inline-form">
														<input type="hidden" name="agent" value={row.agent} />
														<input type="hidden" name="workKind" value={row.workKind} />
														<input type="hidden" name="level" value={row.nextLevel} />
														<input
															type="hidden"
															name="reason"
															value={`${row.reviewed} reviewed, ${rate(row.approvalRate)} approved, ${rate(row.editRate)} edited, ${row.recentRefusals} refusals in the last ${row.recentOfRuns}.`}
														/>
														<input
															type="hidden"
															name="requestId"
															value={`${data.requestId}-level-${row.agent}-${row.workKind}`}
														/>
														<SubmitButton
															label={`Move to ${LEVEL_LABEL[row.nextLevel]}`}
															workingLabel="Moving"
															record={`${agentLabel(row.agent)}, ${row.label}`}
														/>
													</form>
												{:else}
													<span class="faint small">An administrator signs this off.</span>
												{/if}
											{:else}
												<span class="faint small">{row.verdict}</span>
											{/if}
											{#if data.isAdmin && row.level !== 'shadow'}
												<form method="POST" action="?/level" use:enhance class="inline-form">
													<input type="hidden" name="agent" value={row.agent} />
													<input type="hidden" name="workKind" value={row.workKind} />
													<input type="hidden" name="level" value="shadow" />
													<input type="hidden" name="reason" value="Turned down from the agents page." />
													<input
														type="hidden"
														name="requestId"
														value={`${data.requestId}-down-${row.agent}-${row.workKind}`}
													/>
													<SubmitButton
														label="Turn it down"
														workingLabel="Turning down"
														tone="plain"
														record={`${agentLabel(row.agent)}, ${row.label}`}
													/>
												</form>
											{/if}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				</section>
			{/each}
		</Panel>

		<!-- The undo window, which only means something while it is open. -->
		{#await data.undoable}
			<SkeletonRows rows={2} label="Loading the undo window" />
		{:then undoable}
			{#if undoable.length > 0}
				<Panel title="Still inside its undo window">
					<p class="faint">
						An agent did these on its own. Taking one back goes through the same checked write a
						person's own decision would.
					</p>
					{#if undoMessage}
						<p class="notice" class:warn={'failed' in undoMessage}>{undoMessage.message}</p>
					{/if}
					<ul class="rows">
						{#each undoable as action (action.id)}
							<li>
								<div>
									<strong>{action.action}</strong> on {action.entity} {action.entityId}, as
									{action.actedByName}, {moment(action.actedAt)}.
									<span class="faint small"
										>Undo until {moment(action.undoUntil ?? action.actedAt)}.</span
									>
								</div>
								<form method="POST" action="?/undo" use:enhance class="inline-form">
									<input type="hidden" name="actionId" value={action.id} />
									<input type="hidden" name="reason" value="Taken back from the agents page." />
									<input type="hidden" name="requestId" value={`${data.requestId}-undo-${action.id}`} />
									<SubmitButton
										label="Undo"
										workingLabel="Undoing"
										tone="danger"
										record={`${action.action} on ${action.entity} ${action.entityId}`}
									/>
								</form>
							</li>
						{/each}
					</ul>
				</Panel>
			{/if}
		{/await}

		<!-- The only review there is at level auto. -->
		{#await data.sampleQueue then queue}
			{#if queue.length > 0}
				<Panel title="Sampled for review">
					<p class="faint">
						At auto, nobody is asked first. A share of what it did is put here afterwards, and a
						sample that goes bad takes the agent off auto without anybody deciding it.
					</p>
					{#if sampleMessage}
						<p class="notice" class:warn={'failed' in sampleMessage}>{sampleMessage.message}</p>
					{/if}
					<ul class="rows">
						{#each queue as action (action.id)}
							<li>
								<div>
									<strong>{action.action}</strong> on {action.entity} {action.entityId},
									{moment(action.actedAt)}, as {action.actedByName}.
								</div>
								<div class="pair">
									{#each ['good', 'bad'] as verdict (verdict)}
										<form method="POST" action="?/sample" use:enhance class="inline-form">
											<input type="hidden" name="actionId" value={action.id} />
											<input type="hidden" name="verdict" value={verdict} />
											<input
												type="hidden"
												name="requestId"
												value={`${data.requestId}-sample-${action.id}-${verdict}`}
											/>
											<SubmitButton
												label={verdict === 'good' ? 'Fine' : 'Not fine'}
												workingLabel="Recording"
												tone={verdict === 'good' ? 'plain' : 'danger'}
												record={`${action.action} on ${action.entity} ${action.entityId}`}
											/>
										</form>
									{/each}
								</div>
							</li>
						{/each}
					</ul>
				</Panel>
			{/if}
		{/await}

		<!-- 2. What were they refused, and why? -->
		<Panel title="What they were refused">
			<p class="faint">
				Every guardrail has a name, and every refusal is counted against the kind of work it
				happened on. A refusal inside the rule's window stops a promotion.
			</p>
			{#await data.refusals}
				<SkeletonRows rows={4} label="Loading the refusals" />
			{:then refusals}
				{#if refusals.length === 0}
					<EmptyState line="No guardrail has refused anything yet." />
				{:else}
					<div class="table-wrap">
						<table>
							<thead>
								<tr><th>Check</th><th>Agent</th><th>Work</th><th class="num">Times</th><th>Last one</th></tr>
							</thead>
							<tbody>
								{#each refusals as refusal (`${refusal.checkId}-${refusal.agent}-${refusal.workKind}`)}
									<tr>
										<td class="mono">{refusal.checkId}</td>
										<td>{agentLabel(refusal.agent)}</td>
										<td>{refusal.workKind || '-'}</td>
										<td class="num">{count(refusal.times)}</td>
										<td class="faint small">{refusal.lastDetail}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			{/await}
		</Panel>

		{#await data.degradations then degradations}
			{#if degradations.length > 0}
				<Panel title="When something was missing">
					<p class="faint">
						A run that fell back to a cheaper honest path. A degraded run never acts on its own,
						whatever its level.
					</p>
					<div class="table-wrap">
						<table>
							<thead>
								<tr><th>Reason</th><th>Agent</th><th class="num">Times</th><th>What happened instead</th></tr>
							</thead>
							<tbody>
								{#each degradations as row (`${row.reason}-${row.agent}`)}
									<tr>
										<td class="mono">{row.reason}</td>
										<td>{agentLabel(row.agent)}</td>
										<td class="num">{count(row.times)}</td>
										<td class="faint small">{row.lastDetail}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				</Panel>
			{/if}
		{/await}

		<!-- 1. What did the agents do? -->
		<Panel title="What they did">
			<p class="faint">
				One row per agent action, whichever agent it was, from the tables the features already
				write. {#if data.sources.purchase === false}This database has no purchase requests yet, so
					the procurement desk's own work is not in the list.{/if}
			</p>
			<nav class="filters" aria-label="Filter by agent">
				<a href="/agents" aria-current={data.filters.agent === null ? 'page' : undefined}>Every agent</a>
				{#each data.scopes as scope (scope.id)}
					<a
						href={`/agents?agent=${scope.id}`}
						aria-current={data.filters.agent === scope.id ? 'page' : undefined}>{scope.name}</a
					>
				{/each}
			</nav>
			{#await data.runs}
				<SkeletonRows rows={8} label="Loading what the agents did" />
			{:then runs}
				{#if runs.length === 0}
					<EmptyState line="No agent has run yet. The desks wake on mail." href="/desk" action="Open the desk" />
				{:else}
					<div class="table-wrap">
						<table>
							<thead>
								<tr>
									<th>When</th>
									<th>Agent</th>
									<th>Work</th>
									<th>Woke on</th>
									<th class="num">Lookups</th>
									<th>Produced</th>
									<th>Outcome</th>
									<th>Reviewed</th>
								</tr>
							</thead>
							<tbody>
								{#each runs as run (run.runKey)}
									<tr>
										<td class="small">{moment(run.startedAt)}</td>
										<td>{agentLabel(run.agent)}</td>
										<td>{run.workKind}</td>
										<td class="faint small">{run.wakeDetail || run.wokeBy}</td>
										<td class="num">{count(run.toolCallCount)}</td>
										<td class="small">
											{run.produced}
											{#if run.action}
												<span class="pill strong"
													>acted alone at {LEVEL_LABEL[run.action.atLevel]}</span
												>
												{#if run.action.status === 'undone'}<span class="pill warn">undone</span>{/if}
												{#if run.action.sampled}<span class="pill">sampled</span>{/if}
											{/if}
										</td>
										<td class="small">
											{OUTCOME_WORD[run.outcome] ?? run.outcome}
											{#if run.guardrail}
												<span class="pill warn">{run.guardrail}</span>
												<span class="faint small">{run.guardrailReason}</span>
											{/if}
											{#if run.degraded}<span class="pill warn">{run.degradedReason}</span>{/if}
										</td>
										<td class="small">
											{#if run.reviewState === 'waiting'}
												<a href="/workspace">waiting</a>
											{:else if run.reviewState === 'none'}
												<span class="faint">nobody</span>
											{:else}
												{run.reviewState === 'edited_approved' ? 'edited, then approved' : run.reviewState}
												{#if run.reviewedByName}<span class="faint">by {run.reviewedByName}</span>{/if}
												{#if run.editDeltaChars !== null && run.editDeltaChars > 0}
													<span class="faint small">{count(run.editDeltaChars)} characters changed</span>
												{/if}
											{/if}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			{/await}
		</Panel>

		{#await data.changes then changes}
			{#if changes.length > 0}
				<Panel title="Every change of level">
					<ul class="rows">
						{#each changes as change (`${change.agent}-${change.workKind}-${change.at}`)}
							<li>
								<div>
									{agentLabel(change.agent)}, {change.workKind}: {change.fromLevel} to
									<strong>{change.toLevel}</strong>,
									{change.via === 'person' ? (change.byName ?? 'somebody') : 'by rule, nobody decided it'},
									{moment(change.at)}.
									<span class="faint small">{change.reason}</span>
								</div>
							</li>
						{/each}
					</ul>
				</Panel>
			{/if}
		{/await}
	{/if}
</Page>

<style>
	.notice {
		border: 1px solid var(--line);
		border-radius: var(--radius-sm, 6px);
		padding: 0.6rem 0.75rem;
		margin: 0 0 1rem;
	}
	.notice.warn {
		border-color: var(--warn, #b45309);
	}
	.inline-form {
		display: inline-flex;
		gap: 0.4rem;
		align-items: center;
		margin: 0.25rem 0.25rem 0 0;
	}
	.agent {
		margin-top: 1.25rem;
	}
	.agent-head {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: baseline;
	}
	.agent-head h3 {
		margin: 0;
	}
	/* Flexbox rather than grid: the layout has to behave the same in Safari
	   on a phone as it does in Chrome, and a wrapping row of sections does. */
	.scope {
		display: flex;
		flex-wrap: wrap;
		gap: 1rem 2rem;
	}
	.scope section {
		flex: 1 1 18rem;
		min-width: 0;
	}
	.scope h3 {
		font-size: 0.8125rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		margin: 0.75rem 0 0.25rem;
	}
	.scope ul {
		margin: 0;
		padding-left: 1.1rem;
	}
	.scope li,
	.scope p {
		font-size: 0.875rem;
		margin: 0.15rem 0;
	}
	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.rows li {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 1rem;
		align-items: center;
		justify-content: space-between;
		padding: 0.55rem 0;
		border-top: 1px solid var(--line);
	}
	.pair {
		display: flex;
		gap: 0.4rem;
	}
	.filters {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 0.75rem;
		margin: 0 0 0.75rem;
		font-size: 0.875rem;
	}
	.filters a[aria-current='page'] {
		font-weight: 600;
		text-decoration: none;
	}
	.pill {
		display: inline-block;
		border: 1px solid var(--line);
		border-radius: 999px;
		padding: 0.05rem 0.5rem;
		font-size: 0.75rem;
		white-space: nowrap;
	}
	.pill.strong {
		font-weight: 600;
	}
	.pill.warn {
		border-color: var(--warn, #b45309);
	}
	.small {
		font-size: 0.875rem;
	}
	.faint {
		color: var(--ink-faint, #6b7280);
	}
	.faint.small {
		display: block;
	}
	.mono {
		font-family: var(--mono, ui-monospace, monospace);
	}
	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
</style>
