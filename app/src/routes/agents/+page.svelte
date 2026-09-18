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
	import SubmitButton from '$lib/components/ui/SubmitButton.svelte';
	import Tabs from '$lib/components/ui/Tabs.svelte';
	import LoadFailed from '$lib/components/ui/LoadFailed.svelte';
	import Refusals from '$lib/components/agents/Refusals.svelte';
	import TrustTrend from '$lib/components/agents/TrustTrend.svelte';
	import { count, moment, percent } from '$lib/format';
	import { LEVEL_LABEL, LEVEL_MEANING } from '$lib/harness/levels';
	import { AUTONOMY_LABEL } from '$lib/roles/types';
	import { routes } from '$lib/routes';
	import type { AgentTrustRow } from '$lib/server/harness/trust';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	/*
	  The three rungs an MCP token can stand on, in order.

	  'shadow' is the fourth rung of the ladder and is deliberately not here: it
	  means "it drafts and nobody is asked to look", and a coding agent has no
	  draft to keep, so there would be nothing to show anyone. The labels and
	  the sentences come from $lib/harness/levels, the same ones every other
	  level on this page uses.
	*/
	const TOKEN_LEVELS = ['suggest', 'auto_review', 'auto'] as const;

	/** A distinct request id per form on the page, from the one the load made. */
	function reqId(kind: string, key: string): string {
		return `${data.requestId}-${kind}-${key}`;
	}

	const agents = $derived(data.agents);
	const anyPaused = $derived(agents.some((a) => a.paused));
	const everythingStopped = $derived(agents.length > 0 && agents.every((a) => a.paused));
	/** The global brake specifically, which is not the same as every agent looking stopped. */
	const globallyStopped = $derived(data.globalPause?.paused === true);

	/*
	  There is deliberately NO row of page-wide totals here.

	  A merged "agents handled N runs, approval rate X" hides the one thing a
	  person came to find out, which is that one desk may be ready for more
	  autonomy and the other is not. The order desk has volume and the
	  procurement desk has almost none; averaged together they produce a figure
	  that describes neither and would be quoted as though it described both.
	  Every figure on this page belongs to one named agent.
	*/

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

	/*
	  Which sources the unified run view is built from in this database.

	  nl.agent_runs is assembled by a function from the tables that exist, so a
	  feature whose table has not landed contributes no rows. The procurement
	  desk is the live case: its own table is not in the view yet, so its row
	  reads as nothing yet. Saying which sources are in beats letting an agent
	  look idle when it is really unrecorded.
	*/
	const missingSources = $derived(
		Object.entries(data.sources)
			.filter(([, present]) => !present)
			.map(([name]) => name)
	);

	/** The tabs for the one chart. The URL carries the choice, so a view can be linked. */
	const trendTabs = $derived([
		{ value: 'all', label: 'Everything' },
		...agents.map((a) => ({ value: a.agent, label: a.name }))
	]);
</script>

<Page
	title="Agents"
	subtitle="What each agent handled, what a person did with it, what it refused to do, and how far it may go on its own."
>
	{#snippet actions()}
		<!--
			The brake, first thing on the page and available to everybody.

			A screen about trust that cannot stop anything is a brochure. It
			reads the 'all' pause row itself rather than inferring it from every
			agent looking stopped, because five separate pauses and one global
			pause are different facts and the button lifts the global one.
		-->
		<form method="POST" action="?/pause" use:enhance>
			<input type="hidden" name="agent" value="all" />
			<input type="hidden" name="paused" value={globallyStopped ? 'false' : 'true'} />
			<input type="hidden" name="requestId" value={reqId('pause', 'all')} />
			{#if !globallyStopped}
				<input type="hidden" name="reason" value="Stopped from the agents page" />
			{/if}
			<SubmitButton
				label={globallyStopped ? 'Let them all go' : 'Stop every agent'}
				workingLabel={globallyStopped ? 'Letting go' : 'Stopping'}
				tone={globallyStopped ? 'plain' : 'danger'}
				disabled={globallyStopped && !data.mayRelease}
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
			{globallyStopped
				? `Every agent is stopped${data.globalPause?.byName ? `, by ${data.globalPause.byName}` : ''}${data.globalPause?.reason ? `: ${data.globalPause.reason}` : ''}.`
				: everythingStopped
					? 'Every agent is stopped, one at a time rather than by the global brake.'
					: 'Some agents are stopped.'}
			A stopped agent still reads its work and still drafts. It does not act, whatever level it is
			set to. Starting one again is an administrator's.
		</p>
	{/if}

	<!--
		1. The refusals, high on the page and on purpose.

		Each row carries the rule in a person's words and the file the rule is
		really enforced in, not just the check's id. A count of refusals with no
		rule beside it is a number nobody can argue with, which is the opposite
		of what this page is for. Under it, the checks that have not had to
		refuse anything yet, because "what would stop it" gets asked as often as
		"what has stopped it".
	-->
	<Panel
		title="What they refused to do"
		asOf={data.today}
		source="the named guardrail checks, counted from nl.agent_events"
	>
		<Refusals
			refusals={data.refusals}
			roster={data.roster}
			agentName={(id) => agents.find((a) => a.agent === id)?.name ?? id}
		/>
	</Panel>

	<!-- 2. One row per agent, never a merged figure across them. -->
	<Panel
		title="One row per agent"
		asOf={data.today}
		source="the agent run log and the autonomy board, both read once"
		flush
	>
		<div class="panel-body">
			<p class="t-meta muted prose">
				Every agent separately, and no combined figure anywhere on this page. One desk may have
				earned more room and the other may not, and an average across them would describe
				neither.
				{#if missingSources.length > 0}
					<!--
						Straight from nl.agent_runs_sources(). An agent whose feature
						table is not in the unified view yet has no runs to show, and
						that is a different statement from an agent that never works.
					-->
					Not every source is in the run log in this database yet:
					<span class="mono">{missingSources.join(', ')}</span>
					{missingSources.length === 1 ? 'is' : 'are'} missing, so any agent that writes only
					there reads as nothing yet.
				{/if}
			</p>
		</div>

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

										  The branch called desk-depth builds it, and it is
										  deliberately not duplicated here. Two components on one
										  page listing the same runs would be exactly the second
										  count of one thing this page exists to avoid.

										  It belongs INSIDE this open detail, under the kinds of
										  work: this is the one place on the page where a person
										  has already chosen an agent and now wants the runs
										  themselves rather than a rate.

										  On desk-depth the two components are

										    app/src/lib/components/agentruns/RunList.svelte
										    app/src/lib/components/agentruns/RunTrail.svelte

										  and RunList's own header says it takes rows and renders
										  them and knows nothing about where they came from, so it
										  mounts as it is:

										    <RunList runs={runs} showAgent={false} />

										  Give it its own promise in +page.server.ts, keyed on the
										  open agent and NOT awaited, with RunListSkeleton behind
										  an {#await}, so the rest of this page never waits on it.
										  Its rows come from the same view everything here reads:
										  $lib/server/agentruns/read.ts on that branch, or
										  listRuns() in $lib/server/harness/runs.ts on this one.
										  Whichever it is, it must stay a read of
										  nl.agent_run_log, so the trail and the rates above it
										  cannot disagree.
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
										{:else if data.mayPromote}
											<p class="t-meta muted">
												{agent.name} has no row in <span class="mono">nl.users</span> yet, so its
												autonomy is not a grant and there is nothing here to raise. Only the two
												desk agents and the MCP tokens are principals. Its per-work-kind level is
												on the board above.
											</p>
										{/if}

										<!--
											This is its OWN {#if}, not another arm of the chain above. It
											was an {:else if} at first, which meant it only drew while the
											mcp row happened to have no autonomy grant of its own. That is
											true today and it is true by accident: grants are resolved by
											mailbox kind (harness/trust.ts) and only the two desk agents
											map. The moment anything gave the mcp row a grant, the whole
											token list would have vanished with no error.
										-->
										{#if data.mayPromote && agent.agent === 'mcp'}
											<!--
											  4b. The same write, one token at a time.

											  An outside coding agent is not one agent, it is one
											  per token, and each token acts as a different person.
											  So the dial is per token: its own agent-kind row in
											  nl.users, its own grant, raised through the same
											  nl.grant_authority as everything else on this page
											  (migration 0044).

											  The tools a token is offered follow from this and
											  nothing else. At suggest it sees propose_* and a
											  person approves; from act with review it sees the
											  same changes under their own names. Nobody has to
											  remember to keep a second list in step, because there
											  is no second list.
											-->
											<section class="promote">
												<h3 class="t-section">How far each token may go</h3>
												<p class="t-meta muted">
													A token acts as one named person and can do what that person can do.
													This is the only thing that says how far it goes without asking. It is
													the same
													<span class="mono">nl.grant_authority</span> call as raising a person's
													ceiling, audited and effective-dated. Mint and revoke tokens on
													<a href="/settings/mcp">/settings/mcp</a>.
												</p>

												{#if data.mcpTokens.length === 0}
													<p class="t-meta muted">
														No live tokens. Mint one on <a href="/settings/mcp">/settings/mcp</a>;
														it starts at suggest.
													</p>
												{:else}
													{#each data.mcpTokens as token (token.id)}
														<form method="POST" action="?/tokenAutonomy" use:enhance>
															<input type="hidden" name="tokenId" value={token.id} />
															<input
																type="hidden"
																name="requestId"
																value={reqId('token', String(token.id))}
															/>
															<p class="t-meta">
																<strong>{token.label}</strong>, acting as {token.actsAsName}.
																{count(token.calls)} calls, {count(token.callsToday)} today.
																Now at <strong>{LEVEL_LABEL[token.level]}</strong>:
																{LEVEL_MEANING[token.level]}
															</p>
															{#if token.principalId === null}
																<!--
																	Minted before migration 0044, so it has no principal to
																	hold a grant yet. Making one needs an admin, while moving
																	a level needs change_policy, so this one row can refuse
																	somebody the rest of the page works for. Saying so here
																	beats a 403 they cannot explain.
																-->
																<p class="t-meta muted">
																	This token predates the autonomy grant, so an administrator has
																	to move it once before anybody with
																	<span class="mono">change_policy</span> can. It behaves as
																	suggest meanwhile.
																</p>
															{/if}
															<div class="controls">
																<label>
																	<span class="t-meta muted">Level</span>
																	<select name="level" value={token.level}>
																		{#each TOKEN_LEVELS as level (level)}
																			<option value={level}>{LEVEL_LABEL[level]}</option>
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
																<SubmitButton
																	label="Save the grant"
																	workingLabel="Saving"
																	tone="primary"
																/>
															</div>
														</form>
													{/each}
													<p class="t-meta muted">
														A stolen token at suggest can read what its person can read and ask
														for changes nobody has to grant. At act it can make those changes.
														What limits it either way is the same thing: the person's authority
														and its ceiling, the policy engine's cap, the undo window at act
														with review, and the stop button below, which works at every level.
													</p>
												{/if}
											</section>
										{/if}

										<!--
											The brake, OUTSIDE the promotion gate on purpose.

											nl.set_agent_pause lets anybody active pull it and only
											an admin let it go, because hitting the brake should
											never need a permission. Drawing this button only for
											somebody who may change a policy would put a permission
											in front of the one control that must not have one, and
											it would make the page disagree with the database.
										-->
										<form class="brake" method="POST" action="?/pause" use:enhance>
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
											{#if agent.paused}
												<p class="t-meta muted">
													Stopped. It still reads its work and still drafts; it acts on nothing.
													Starting it again is an administrator's.
												</p>
												<SubmitButton
													label="Let {agent.name} go"
													workingLabel="Letting go"
													tone="plain"
													disabled={!data.mayRelease}
												/>
											{:else}
												<label class="why">
													<span class="t-meta muted">Reason</span>
													<input
														type="text"
														name="reason"
														maxlength="500"
														placeholder="Checking a reply that read badly"
													/>
												</label>
												<SubmitButton
													label="Stop {agent.name}"
													workingLabel="Stopping"
													tone="danger"
												/>
											{/if}
										</form>
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
			<!--
				The house Tabs component rather than a hand-rolled nav: it keeps
				every other query parameter when it switches, which a plain set
				of links does not, and it is anchors so copy-link still works.
			-->
			<Tabs
				param="agent"
				current={data.agent ?? 'all'}
				label="Whose trend to show"
				tabs={trendTabs}
			/>
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
		source={data.evals.source === 'run'
			? 'the last whole eval run'
			: data.evals.source === 'baseline'
				? 'the recorded baseline, not a fresh run'
				: 'nothing on file'}
		flush
	>
		{#if data.evals.source === 'none'}
			<div class="panel-body">
				<EmptyState
					line="No eval baseline and no run on file. Run npm run eval:agents to write both."
				/>
			</div>
		{:else}
			{#if data.evals.source === 'baseline'}
				<!--
					The run artifact is written by the runner and is not committed,
					so a fresh checkout has a baseline and no artifact. Showing the
					baseline is honest; showing zeros would say the evals do not
					exist, which is the worst lie this page could tell. It is
					labelled either way.
				-->
				<div class="panel-body">
					<p class="t-meta muted prose">
						These are the <strong>recorded baseline</strong> figures, which is the floor
						<span class="mono">npm test</span> holds the suites to, not the result of a run made
						just now. Running <span class="mono">npm run eval:agents</span> writes a fresh result
						beside the baseline and this panel then shows both and compares them.
					</p>
				</div>
			{/if}
			<div class="table-wrap">
				<table>
					<caption class="sr-only">
						Each eval suite: cases fully right, against the baseline, with a link into a case
					</caption>
					<thead>
						<tr>
							<th scope="col">Suite</th>
							<th scope="col" class="num">Fully right</th>
							<th scope="col" class="num">Baseline</th>
							<th scope="col">Against the baseline</th>
							<th scope="col">Fields scored</th>
							<th scope="col">A case</th>
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
									{#if data.evals.source !== 'run'}
										<span class="muted">This IS the baseline.</span>
									{:else if suite.baselinePassed === null}
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
								<td>
									<!--
										A real link into a real case, built from the first case
										name on disk rather than from a filename typed into the
										markup. A page that names a case file that does not
										exist is worse than one that names none.
									-->
									{#if suite.caseNames.length > 0}
										<a
											class="link"
											href={routes.agentEvalCase(suite.folder, suite.caseNames[0])}
										>
											Read one
										</a>
										<span class="t-meta muted wrap">
											{count(suite.caseNames.length)} on file
										</span>
									{:else}
										<span class="muted">no case files</span>
									{/if}
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
						The last run is written up in <span class="mono">{data.evals.reportPath}</span>.
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

	/* A cell's supporting line goes under its value, not beside it. */
	.wrap {
		display: block;
		white-space: normal;
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

	/*
	  The brake. Flexbox rather than grid, like the rest of this app: auto-fit
	  grid tracks behave differently on Safari iOS and this project has been
	  bitten by that.
	*/
	.brake {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: var(--space-2);
	}

	.brake .why {
		flex: 1 1 220px;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.brake p {
		flex-basis: 100%;
		margin: 0;
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
