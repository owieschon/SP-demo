<script lang="ts">
	/*
	  /agents: can these agents be trusted, and what do I do about it.

	  The machinery behind this page has existed for a while and nothing
	  showed it. That is the whole reason the page exists: a run record for
	  every agent, guardrails as named checks, an autonomy ladder with a
	  written rule, an undo window, a pause switch and 75 scored eval cases
	  are all worth nothing to a sceptical person who cannot see them.

	  It is a trust surface, not a dashboard. Every figure answers a question
	  somebody actually asks before they let software write to their business,
	  and anything that does not change that decision is left off however easy
	  it would be to add. No tile carries a bare number; each one says what it
	  is measured against, in words.

	  The order is an argument, not a layout:

	    1. the brake, because a screen about trust that cannot stop anything
	       is a brochure;
	    2. what the agents REFUSED to do, which is the most persuasive thing
	       here and the thing nobody ever shows;
	    3. one row per agent with the numbers a sceptic asks for;
	    4. the trend, with the promotion threshold drawn on it;
	    5. the promotion control, beside the eval evidence for it;
	    6. the evals per suite against their baseline.
	*/
	import { enhance } from '$app/forms';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import FormNotice from '$lib/components/ui/FormNotice.svelte';
	import Page from '$lib/components/ui/Page.svelte';
	import Panel from '$lib/components/ui/Panel.svelte';
	import SkeletonRows from '$lib/components/ui/SkeletonRows.svelte';
	import Stat from '$lib/components/ui/Stat.svelte';
	import SubmitButton from '$lib/components/ui/SubmitButton.svelte';
	import LoadFailed from '$lib/components/ui/LoadFailed.svelte';
	import TrustTrend from '$lib/components/agents/TrustTrend.svelte';
	import { count, moment, percent } from '$lib/format';
	import { LEVEL_LABEL, LEVEL_MEANING } from '$lib/harness/levels';
	import { AUTONOMY_LABEL } from '$lib/roles/types';
	import { routes } from '$lib/routes';
	import type { AgentTrustRow } from '$lib/server/harness/trust';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	/** A distinct request id per form on the page, from the one the load made. */
	function reqId(kind: string, key: string): string {
		return `${data.requestId}-${kind}-${key}`;
	}

	const agents = $derived(data.agents);
	const anyPaused = $derived(agents.some((a) => a.paused));
	const everythingStopped = $derived(agents.length > 0 && agents.every((a) => a.paused));

	/** The page-wide totals. Each one is a sum of the rows below it, nothing new. */
	const total = $derived({
		runs: agents.reduce((sum, a) => sum + a.runs, 0),
		reviewed: agents.reduce((sum, a) => sum + a.reviewed, 0),
		approved: agents.reduce((sum, a) => sum + a.approved, 0),
		edited: agents.reduce((sum, a) => sum + a.edited, 0),
		rejected: agents.reduce((sum, a) => sum + a.rejected, 0),
		refusals: agents.reduce((sum, a) => sum + a.refusals, 0),
		actedAlone: agents.reduce((sum, a) => sum + a.actedAlone, 0),
		undone: agents.reduce((sum, a) => sum + a.undone, 0)
	});

	const overallApproval = $derived(
		total.approved + total.edited + total.rejected === 0
			? null
			: (total.approved + total.edited) / (total.approved + total.edited + total.rejected)
	);

	/** "nothing yet" and not "0%". An agent nobody has reviewed is not an agent at zero. */
	function rate(value: number | null): string {
		return value === null ? 'nothing yet' : percent(value);
	}

	/** What an agent's levels read as when its kinds of work are not all at one level. */
	function levelWords(a: AgentTrustRow): string {
		if (a.levels.length === 0) return 'no kind of work on the board';
		if (a.levels.length === 1) {
			const one = a.levels[0];
			return `${LEVEL_LABEL[one.level]} on all ${one.workKinds} kind${one.workKinds === 1 ? '' : 's'} of work`;
		}
		return a.levels
			.map((l) => `${LEVEL_LABEL[l.level]} on ${l.workKinds}`)
			.join(', ');
	}

	/** The agent whose trend is showing, for the chart's own label. */
	const trendLabel = $derived(
		data.agent === null
			? 'Every agent together'
			: (agents.find((a) => a.agent === data.agent)?.name ?? data.agent)
	);

	/** Which agent's detail is open. One at a time: this is a reading screen. */
	let open = $state<string | null>(null);
	const toggle = (key: string) => (open = open === key ? null : key);

	const evalsBeaten = $derived(data.evals.suites.filter((s) => s.beatBaseline).length);
</script>

<Page
	title="Agents"
	subtitle="What each agent handled, what a person did with it, what it refused to do, and how far it may go on its own."
>
	{#snippet actions()}
		<form method="POST" action="?/pause" use:enhance>
			<input type="hidden" name="agent" value="all" />
			<input type="hidden" name="paused" value={everythingStopped ? 'false' : 'true'} />
			<input type="hidden" name="requestId" value={reqId('pause', 'all')} />
			<SubmitButton
				label={everythingStopped ? 'Let them all go' : 'Stop every agent'}
				workingLabel={everythingStopped ? 'Letting go' : 'Stopping'}
				tone={everythingStopped ? 'plain' : 'danger'}
			/>
		</form>
	{/snippet}

	<FormNotice {form} />

	{#if !data.mayPromote}
		<p class="t-meta muted">
			You can read all of this. Changing what an agent may do on its own needs the authority to
			change a policy, which is the same authority that raises a person's approval limit.
			Stopping an agent does not: anybody can pull the brake.
		</p>
	{/if}

	{#if anyPaused}
		<p class="stopped">
			{everythingStopped ? 'Every agent is stopped.' : 'Some agents are stopped.'}
			A stopped agent still reads its work and still drafts. It does not act, whatever level it is
			set to.
		</p>
	{/if}

	<!-- 1. The four figures that decide the question, each against something. -->
	<dl class="figures">
		<Stat
			label="Runs on the record"
			value={count(total.runs)}
			unit="runs"
			compare="every run every agent has made, not a sample"
			source="agent run log"
			asOf={data.today}
		/>
		<Stat
			label="Approval rate"
			value={rate(overallApproval)}
			compare={total.reviewed === 0
				? 'nobody has decided one yet'
				: `${count(total.approved + total.edited)} let through of ${count(total.reviewed)} a person decided`}
			source="agent run log"
			asOf={data.today}
		/>
		<Stat
			label="Corrected first"
			value={rate(
				total.approved + total.edited === 0 ? null : total.edited / (total.approved + total.edited)
			)}
			compare={total.approved + total.edited === 0
				? 'nothing has been let through yet'
				: `${count(total.edited)} of the ${count(total.approved + total.edited)} let through were edited`}
			source="agent run log"
			asOf={data.today}
		/>
		<Stat
			label="Refused by a guardrail"
			value={count(total.refusals)}
			unit="runs"
			compare={total.runs === 0
				? 'no runs yet'
				: `${percent(total.refusals / Math.max(total.runs, 1))} of ${count(total.runs)} runs stopped themselves`}
			source="named guardrail checks"
			asOf={data.today}
			tone={total.refusals > 0 ? 'plain' : 'warn'}
			toneWord={total.refusals > 0 ? undefined : 'nothing has been refused, which is worth a look'}
		/>
	</dl>

	<!-- 2. The refusals, high on the page and on purpose. -->
	<Panel
		title="What they refused to do"
		asOf={data.today}
		source="the named guardrail checks, counted from nl.agent_events"
		flush
	>
		{#if data.refusals.length === 0}
			<div class="panel-body">
				<EmptyState
					line="Nothing has been refused yet. On a page about trust that is a question, not a clean bill: either nothing has run, or the checks are not being reached."
				/>
			</div>
		{:else}
			<div class="table-wrap">
				<table>
					<caption class="sr-only">
						Every guardrail refusal, by check, with how often it fired and what it last said
					</caption>
					<thead>
						<tr>
							<th scope="col">The rule</th>
							<th scope="col">Agent</th>
							<th scope="col">On what</th>
							<th scope="col" class="num">Times</th>
							<th scope="col">What it said, last time</th>
						</tr>
					</thead>
					<tbody>
						{#each data.refusals as refusal (`${refusal.agent}-${refusal.workKind}-${refusal.checkId}`)}
							<tr>
								<th scope="row"><span class="mono">{refusal.checkId}</span></th>
								<td>{agents.find((a) => a.agent === refusal.agent)?.name ?? refusal.agent}</td>
								<td class="muted">{refusal.workKind}</td>
								<td class="num">{count(refusal.times)}</td>
								<td class="said">
									{refusal.lastDetail || 'no detail recorded'}
									<span class="t-meta muted">{moment(refusal.lastAt)}</span>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</Panel>

	<!-- 3. One row per agent. -->
	<Panel
		title="One row per agent"
		asOf={data.today}
		source="the agent run log and the autonomy board, both read once"
		flush
	>
		<div class="table-wrap">
			<table>
				<caption class="sr-only">
					Every agent: runs handled, approval rate, edit rate, refusals, autonomy level and
					whether it is stopped
				</caption>
				<thead>
					<tr>
						<th scope="col">Agent</th>
						<th scope="col" class="num">Handled</th>
						<th scope="col" class="num">Waiting</th>
						<th scope="col" class="num">Approval</th>
						<th scope="col" class="num">Edited</th>
						<th scope="col" class="num">Refused</th>
						<th scope="col">Autonomy</th>
						<th scope="col">State</th>
					</tr>
				</thead>
				<tbody>
					{#each agents as agent (agent.agent)}
						<tr class:nothing={agent.runs === 0}>
							<th scope="row">
								<button
									class="disclose"
									type="button"
									aria-expanded={open === agent.agent}
									onclick={() => toggle(agent.agent)}
								>
									{agent.name}
								</button>
								<span class="t-meta muted">{agent.purpose}</span>
							</th>
							{#if agent.runs === 0}
								<td class="muted" colspan="5">
									Nothing yet. This agent has not run in this database, so there is no approval
									rate, no edit rate and no refusals to show, which is different from all of them
									being zero.
								</td>
							{:else}
								<td class="num">{count(agent.runs)}</td>
								<td class="num">{count(agent.waiting)}</td>
								<td class="num">{rate(agent.approvalRate)}</td>
								<td class="num">{rate(agent.editRate)}</td>
								<td class="num" class:negative={agent.refusals > 0}>{count(agent.refusals)}</td>
							{/if}
							<td>
								{levelWords(agent)}
								{#if agent.granted}
									<span class="t-meta muted">
										granted {agent.granted.level === null
											? 'no level'
											: `level ${agent.granted.level}, ${AUTONOMY_LABEL[agent.granted.level]}`}
									</span>
								{:else}
									<span class="t-meta muted">not a principal, so no grant</span>
								{/if}
							</td>
							<td>
								{#if agent.paused}
									<span class="chip warn">Stopped</span>
									<span class="t-meta muted">
										{agent.pausedReason || 'no reason given'}{agent.pausedByName
											? `, by ${agent.pausedByName}`
											: ''}
									</span>
								{:else}
									<span class="chip">Running</span>
								{/if}
							</td>
						</tr>

						{#if open === agent.agent}
							<tr class="detail">
								<td colspan="8">
									<div class="detail-body">
										<p class="t-meta muted">
											Reviewed by {agent.reviewer}
											{#if agent.lastRunAt}
												· last run {moment(agent.lastRunAt)}
											{/if}
											{#if agent.actedAlone > 0}
												· {count(agent.actedAlone)} acted on its own authority, {count(agent.undone)}
												taken back
											{/if}
										</p>

										{#if agent.kinds.length === 0}
											<p class="t-meta muted">
												No kind of work is on the board for this agent yet.
											</p>
										{:else}
											<div class="table-wrap">
												<table>
													<caption class="sr-only">
														{agent.name}: each kind of work, its level and whether it clears the
														promotion rule
													</caption>
													<thead>
														<tr>
															<th scope="col">Kind of work</th>
															<th scope="col">Level</th>
															<th scope="col" class="num">Runs</th>
															<th scope="col" class="num">Decided</th>
															<th scope="col" class="num">Approval</th>
															<th scope="col" class="num">Edited</th>
															<th scope="col">Next step up</th>
														</tr>
													</thead>
													<tbody>
														{#each agent.kinds as kind (kind.workKind)}
															<tr>
																<th scope="row">
																	{kind.label}
																	<span class="t-meta muted mono">{kind.workKind}</span>
																</th>
																<td>
																	{LEVEL_LABEL[kind.level]}
																	<span class="t-meta muted">{LEVEL_MEANING[kind.level]}</span>
																	{#if kind.level === 'auto_review' && kind.undoWindowMinutes > 0}
																		<span class="t-meta muted">
																			{kind.undoWindowMinutes} minutes to undo
																		</span>
																	{/if}
																	{#if kind.level === 'auto' && kind.sampleRate > 0}
																		<span class="t-meta muted">
																			{percent(kind.sampleRate)} sampled afterwards, automatically
																		</span>
																	{/if}
																</td>
																<td class="num">{count(kind.runs)}</td>
																<td class="num">{count(kind.reviewed)}</td>
																<td class="num">{rate(kind.approvalRate)}</td>
																<td class="num">{rate(kind.editRate)}</td>
																<td class:ready={kind.qualifies}>
																	{#if kind.nextLevel === null}
																		<span class="muted">Top level.</span>
																	{:else}
																		<span class="t-meta">
																			{LEVEL_LABEL[kind.nextLevel]}:
																			{kind.verdict}
																		</span>
																	{/if}
																</td>
															</tr>
														{/each}
													</tbody>
												</table>
											</div>
										{/if}

										<!--
										  THE RUN TRAIL MOUNTS HERE.

										  A separate branch (desk-depth) is building a run trail
										  component: the individual runs for one agent, what woke
										  each, the tools it called and what a person decided. It
										  belongs inside this open detail, under the kinds of work,
										  because that is the one place on the page where a person
										  has already chosen an agent and wants to see the runs
										  themselves rather than a rate.

										  Drop it in as:

										    <RunTrail agent={agent.agent} />

										  and give it its own {#await} in +page.server.ts keyed on
										  the open agent, so the rest of this page does not wait on
										  it. Nothing here counts runs a second way, so the trail
										  can read nl.agent_run_log directly through
										  $lib/server/harness/runs listRuns().
										-->

										{#if data.mayPromote && agent.granted}
											<!--
											  4. Promotion, as a person's write.

											  This form calls nl.grant_authority. It is the same
											  call, the same table and the same audit row as raising
											  a person's approval limit: an agent is a principal in
											  nl.users and its autonomy is a grant on it (migration
											  0031). There is no agent-shaped variant, which is the
											  claim the whole roles model rests on.

											  The evidence sits beside it on purpose. A promotion is
											  a person putting their name on a number, so the numbers
											  are in arm's reach when they do.
											-->
											<form class="promote" method="POST" action="?/autonomy" use:enhance>
												<input type="hidden" name="agent" value={agent.agent} />
												<input
													type="hidden"
													name="requestId"
													value={reqId('autonomy', agent.agent)}
												/>
												<h3 class="t-section">How far {agent.name} may go</h3>
												<p class="t-meta muted">
													This writes a grant on {agent.name}'s own row through
													<span class="mono">nl.grant_authority</span>, the same call that raises a
													person's approval ceiling. It is audited and effective-dated: a raise
													from tomorrow leaves today's answer alone.
												</p>

												<p class="evidence t-meta">
													The evidence: {count(agent.reviewed)} runs a person decided,
													{rate(agent.approvalRate)} of them let through,
													{rate(agent.editRate)} of those corrected first,
													{count(agent.refusals)} refused by a guardrail. The evals stand at
													{count(data.evals.passed)} of {count(data.evals.cases)} cases fully
													right, {evalsBeaten} of {data.evals.suites.length} suites at or above
													their baseline.
												</p>

												<div class="controls">
													<label>
														<span class="t-meta muted">Level</span>
														<select name="level" value={String(agent.granted.level ?? 1)}>
															{#each [0, 1, 2, 3] as level (level)}
																<option value={level}>{level}: {AUTONOMY_LABEL[level]}</option>
															{/each}
														</select>
													</label>
													<label>
														<span class="t-meta muted">From</span>
														<input type="date" name="startsOn" placeholder={data.today} />
													</label>
													<label class="why">
														<span class="t-meta muted">Why</span>
														<input
															type="text"
															name="note"
															maxlength="300"
															placeholder="What earned it, or what took it away"
														/>
													</label>
													<SubmitButton label="Save the grant" workingLabel="Saving" tone="primary" />
												</div>

												{#if agent.granted.ahead.length > 0}
													<p class="t-meta muted">
														Already dated forward:
														{#each agent.granted.ahead as ahead (ahead.startsOn)}
															level {ahead.level} from {ahead.startsOn}.
														{/each}
													</p>
												{/if}
											</form>

											<div class="side-by-side">
												<form method="POST" action="?/revokeAutonomy" use:enhance>
													<input type="hidden" name="agent" value={agent.agent} />
													<input
														type="hidden"
														name="requestId"
														value={reqId('revoke', agent.agent)}
													/>
													<SubmitButton
														label="Take the grant away, from today"
														workingLabel="Taking it away"
														tone="danger"
													/>
												</form>

												<form method="POST" action="?/pause" use:enhance>
													<input type="hidden" name="agent" value={agent.agent} />
													<input
														type="hidden"
														name="paused"
														value={agent.paused ? 'false' : 'true'}
													/>
													<input
														type="hidden"
														name="requestId"
														value={reqId('pause', agent.agent)}
													/>
													<SubmitButton
														label={agent.paused ? `Let ${agent.name} go` : `Stop ${agent.name}`}
														workingLabel={agent.paused ? 'Letting go' : 'Stopping'}
													/>
												</form>
											</div>
										{:else if data.mayPromote}
											<p class="t-meta muted">
												{agent.name} has no row in <span class="mono">nl.users</span> yet, so its
												autonomy is not a grant and there is nothing here to raise. Only the two
												desk agents are principals. Its per-work-kind level is on the board above.
											</p>
										{/if}
									</div>
								</td>
							</tr>
						{/if}
					{/each}
				</tbody>
			</table>
		</div>
	</Panel>

	<!-- 5. The one chart. -->
	<Panel
		title="The trust trend"
		asOf={data.today}
		source="the agent run log, bucketed by week"
	>
		{#snippet actions()}
			<nav class="segmented" aria-label="Whose trend to show">
				<a href={routes.agents()} aria-current={data.agent === null ? 'page' : undefined}>
					Everything
				</a>
				{#each agents as agent (agent.agent)}
					<a
						href={routes.agents(agent.agent)}
						aria-current={data.agent === agent.agent ? 'page' : undefined}
					>
						{agent.name}
					</a>
				{/each}
			</nav>
		{/snippet}

		{#await data.trend}
			<SkeletonRows rows={8} cols={6} header label="Loading the weekly trend" />
		{:then trend}
			<TrustTrend {trend} label={trendLabel} />
		{:catch}
			<LoadFailed what="the trust trend" />
		{/await}
	</Panel>

	<!-- 6. The evals, per suite, against the baseline. -->
	<Panel
		title="The eval suites"
		asOf={data.evals.ranOn ?? data.today}
		source={data.evals.ranOn ? 'the last eval run' : 'nothing has run yet'}
		flush
	>
		{#if data.evals.ranOn === null}
			<div class="panel-body">
				<EmptyState
					line="No eval run on file. Run npm run eval:agents to write one; the baseline is on file either way."
				/>
			</div>
		{:else}
			<div class="table-wrap">
				<table>
					<caption class="sr-only">
						Each eval suite: cases fully right in the last run, against the baseline
					</caption>
					<thead>
						<tr>
							<th scope="col">Suite</th>
							<th scope="col" class="num">Fully right</th>
							<th scope="col" class="num">Baseline</th>
							<th scope="col">Against the baseline</th>
							<th scope="col">Fields scored</th>
						</tr>
					</thead>
					<tbody>
						{#each data.evals.suites as suite (suite.suite)}
							<tr>
								<th scope="row">{suite.suite}</th>
								<td class="num">{count(suite.passed)} of {count(suite.cases)}</td>
								<td class="num">
									{#if suite.baselinePassed === null}
										<span class="muted">none</span>
									{:else}
										{count(suite.baselinePassed)} of {count(suite.baselineCases ?? 0)}
									{/if}
								</td>
								<td>
									{#if suite.baselinePassed === null}
										<span class="muted">Nothing to beat yet.</span>
									{:else if suite.beatBaseline}
										<span class="chip">At or above it</span>
									{:else}
										<span class="chip warn">Behind on {suite.worse.join(', ')}</span>
									{/if}
								</td>
								<td class="fields t-meta muted">
									{#each Object.entries(suite.fields) as [field, f1] (field)}
										<span>{field} {f1.toFixed(2)}</span>
									{/each}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<div class="panel-body">
				<p class="t-meta muted prose">
					{data.evals.caveat}
					{#if data.evals.reportPath}
						The run itself is written up in
						<span class="mono">{data.evals.reportPath}</span>, and each case is a file:
						<span class="mono">evals/agents/guardrails/cases/01-refuses-cost-to-a-customer.json</span>
						is one.
					{/if}
				</p>
			</div>
		{/if}
	</Panel>

	<!-- 7. The undo window and the record of who moved what. -->
	<div class="pair">
		<Panel title="Still inside its undo window" asOf={data.today} source="the agent action log">
			{#await data.undoable}
				<SkeletonRows rows={3} cols={3} label="Loading what can still be taken back" />
			{:then undoable}
				{#if undoable.length === 0}
					<EmptyState
						line="Nothing is waiting to be taken back. Either nothing has acted on its own, or every window has closed."
					/>
				{:else}
					<ul class="rows">
						{#each undoable as action (action.id)}
							<li>
								<div>
									<span>{action.action} on {action.entity} {action.entityId}</span>
									<span class="t-meta muted">
										{action.agent}, at {LEVEL_LABEL[action.atLevel]}, acted
										{moment(action.actedAt)}{action.undoUntil
											? `, undoable until ${moment(action.undoUntil)}`
											: ''}
									</span>
								</div>
								{#if action.undoable}
									<form method="POST" action="?/undo" use:enhance>
										<input type="hidden" name="actionId" value={action.id} />
										<input
											type="hidden"
											name="requestId"
											value={reqId('undo', String(action.id))}
										/>
										<input
											type="hidden"
											name="reason"
											value="Taken back from the agents page"
										/>
										<SubmitButton label="Take it back" workingLabel="Taking it back" />
									</form>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			{:catch}
				<LoadFailed what="the undo window" />
			{/await}
		</Panel>

		<Panel title="Who moved what" asOf={data.today} source="the autonomy change log">
			{#await data.levelChanges}
				<SkeletonRows rows={4} cols={3} label="Loading the autonomy history" />
			{:then changes}
				{#if changes.length === 0}
					<EmptyState line="No level has been moved yet. Every agent is where it was seeded." />
				{:else}
					<ul class="rows">
						{#each changes as change (`${change.agent}-${change.workKind}-${change.at}`)}
							<li>
								<div>
									<span>
										{change.agent} {change.workKind}: {change.fromLevel} to {change.toLevel}
									</span>
									<span class="t-meta muted">
										{change.via === 'person'
											? `${change.byName ?? 'somebody'} decided it`
											: 'a rule did it, nobody decided'}
										· {moment(change.at)}
										{#if change.reason}· {change.reason}{/if}
									</span>
								</div>
							</li>
						{/each}
					</ul>
				{/if}
			{:catch}
				<LoadFailed what="the autonomy history" />
			{/await}
		</Panel>
	</div>
</Page>

<style>
	.stopped {
		margin: 0;
		padding: var(--space-3);
		border: 1px solid var(--hairline-strong);
		border-radius: var(--radius);
		background: var(--warning-soft);
		font-size: var(--fs-body);
	}

	/* A row for an agent that has never run is quieter, but its words say so
	   too: the color is never the only signal. */
	.nothing th {
		opacity: 0.85;
	}

	.disclose {
		background: none;
		border: 0;
		padding: 0;
		font: inherit;
		font-weight: 600;
		color: var(--text);
		text-align: left;
		cursor: pointer;
	}

	.disclose:hover {
		text-decoration: underline;
	}

	.disclose:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}

	.detail > td {
		background: var(--surface-sunken);
	}

	.detail-body {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		padding: var(--space-3) 0;
	}

	.said {
		max-width: 44ch;
	}

	.ready {
		color: var(--status-kept);
	}

	.promote {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-3);
		border: 1px solid var(--hairline-strong);
		border-radius: var(--radius);
		background: var(--surface);
	}

	.promote h3 {
		margin: 0;
	}

	.evidence {
		margin: 0;
		padding: var(--space-2);
		border-left: 2px solid var(--hairline-strong);
		background: var(--surface-sunken);
	}

	.controls {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: var(--space-2);
	}

	.controls label {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.controls .why {
		flex: 1 1 220px;
		min-width: 0;
	}

	.side-by-side {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.fields {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1) var(--space-2);
	}

	.pair {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-4);
	}

	.pair > :global(.panel) {
		flex: 1 1 320px;
		min-width: 0;
	}

	.rows li {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--space-3);
	}

	.rows li > div {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
</style>
