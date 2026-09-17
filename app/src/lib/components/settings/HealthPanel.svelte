<script lang="ts">
	// Health: one line per check, green or red, with what to do when it is red.
	// Nothing in here is secret, which is why this is the one section a person
	// without the passcode can still read.
	//
	// The checks on the page are the bounded ones. The two exact drift checks
	// read every row by design, so they sit behind a link and stream in on
	// their own (see diagnostics.ts and migration 0026).
	import { count, moment } from '$lib/format';
	import type { DiagnosticsView, ExactChecksView, HealthCheckView } from './types';

	let {
		health,
		exact
	}: {
		health: DiagnosticsView;
		/** A promise while the exact checks run, or null when nobody asked. */
		exact: Promise<ExactChecksView> | null;
	} = $props();

	const shown = $derived<HealthCheckView[]>(health.checks);
	const bad = $derived(shown.filter((check) => check.state === 'bad').length);
</script>

<section class="panel" id="health">
	<header class="panel-head">
		<h2>Health</h2>
		<span class="faint">
			{bad === 0 ? 'Nothing needs attention' : `${bad} ${bad === 1 ? 'thing needs' : 'things need'} attention`}
			· version {health.version} · checked {moment(health.ranAt)} in {health.ms} ms
		</span>
	</header>

	<ul class="checks">
		{#each shown as check (check.id)}
			<li class={check.state}>
				<span class="dot" aria-hidden="true"></span>
				<span class="what">
					<span class="label">{check.label}</span>
					<span class="detail">{check.detail}</span>
					{#if check.advice}
						<span class="advice">{check.advice}</span>
					{/if}
				</span>
				<span class="sr-only">
					{check.state === 'good' ? 'good' : check.state === 'bad' ? 'needs attention' : 'for information'}
				</span>
			</li>
		{/each}
	</ul>

	<!-- The exact checks. Off the page until asked for, because they read the
	     whole ledger, every commitment and every stock movement. -->
	<div class="exact">
		{#if exact}
			{#await exact}
				<p class="faint" role="status">Reading every commitment, every stock movement and every ledger line.</p>
			{:then result}
				<ul class="checks">
					{#each result.checks as check (check.id)}
						<li class={check.state}>
							<span class="dot" aria-hidden="true"></span>
							<span class="what">
								<span class="label">{check.label}</span>
								<span class="detail">{check.detail}</span>
								{#if check.advice}
									<span class="advice">{check.advice}</span>
								{/if}
							</span>
						</li>
					{/each}
				</ul>
				<p class="faint note">
					Exact, and it took the database {result.ms} ms.
					<a href="/settings#health">Hide them</a>
				</p>
			{:catch}
				<p class="notice error" role="alert">The exact checks did not finish.</p>
			{/await}
		{:else}
			<a class="button" href="/settings?checks=exact#health">Run the exact checks</a>
			<p class="faint note">
				The delivered figures and stock on hand are exact by design: they recount every commitment and every
				stock movement, which takes a few seconds on the full world. The line above samples the ledger
				instead, so the page does not wait.
			</p>
		{/if}
	</div>

	<div class="grids">
		<div class="block">
			<h3 class="eyebrow">Rows, estimated</h3>
			<table>
				<tbody>
					{#each health.counts as row (row.table)}
						<tr>
							<td>{row.table.replace(/_/g, ' ')}</td>
							<td class="num mono">{count(row.rows)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
			<p class="faint note">
				From the statistics Postgres keeps for the planner, so no table is read to draw this. They are
				estimates and can be a little out after a rebuild.
			</p>
		</div>

		<div class="block">
			<h3 class="eyebrow">Environment</h3>
			<table>
				<tbody>
					{#each health.environment as row (row.name)}
						<tr>
							<td class="mono">{row.name}</td>
							<td class="num">
								{#if row.shown}
									<span class="mono">{row.shown}</span>
								{:else if row.set}
									<span class="yes">set</span>
								{:else}
									<span class="faint">not set</span>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
			<p class="faint note">Only whether each one is set. A value is shown here only when it is not a secret.</p>
		</div>
	</div>
</section>

<style>
	.checks {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.checks li {
		display: flex;
		align-items: flex-start;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-3);
	}

	.checks li + li {
		border-top: 1px solid var(--hairline);
	}

	.dot {
		flex: 0 0 auto;
		width: 7px;
		height: 7px;
		margin-top: 6px;
		border-radius: 50%;
		background: var(--text-faint);
	}

	.good .dot {
		background: var(--status-kept);
	}

	.bad .dot {
		background: var(--danger);
	}

	.what {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--space-2);
	}

	.label {
		font-weight: 500;
	}

	.detail {
		color: var(--text-muted);
	}

	.advice {
		flex: 1 1 100%;
		max-width: 80ch;
		color: var(--warning);
		font-size: 0.88rem;
	}

	.exact {
		border-top: 1px solid var(--hairline);
		padding: var(--space-3);
	}

	.exact .checks {
		margin: 0 calc(-1 * var(--space-3)) var(--space-2);
	}

	.exact p {
		margin: 0;
	}

	.grids {
		display: flex;
		flex-wrap: wrap;
		border-top: 1px solid var(--hairline);
	}

	.block {
		flex: 1 1 280px;
		min-width: 0;
		padding: var(--space-3);
	}

	.block + .block {
		border-left: 1px solid var(--hairline);
	}

	h3 {
		margin: 0 0 var(--space-1);
	}

	td {
		height: 26px;
		padding: 2px 0;
		border-bottom: 0;
	}

	.num {
		text-align: right;
	}

	.yes {
		color: var(--status-kept);
	}

	.note {
		margin: var(--space-2) 0 0;
		max-width: 80ch;
		font-size: 0.82rem;
	}

	@media (max-width: 720px) {
		.block + .block {
			border-left: 0;
			border-top: 1px solid var(--hairline);
		}
	}
</style>
