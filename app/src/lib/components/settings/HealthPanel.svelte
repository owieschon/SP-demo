<script lang="ts">
	// Health: one line per check, green or red, with what to do when it is red.
	// Nothing in here is secret, which is why this is the one section a person
	// without the passcode can still read.
	import { count, moment } from '$lib/format';
	import type { DiagnosticsView } from './types';

	let { diagnostics }: { diagnostics: DiagnosticsView } = $props();

	const bad = $derived(diagnostics.checks.filter((check) => check.state === 'bad').length);
</script>

<section class="panel">
	<header class="panel-head">
		<h2>Health</h2>
		<span class="faint">
			{bad === 0 ? 'Nothing needs attention' : `${bad} ${bad === 1 ? 'thing needs' : 'things need'} attention`}
			· version {diagnostics.version} · checked {moment(diagnostics.ranAt)}
		</span>
	</header>

	<ul class="checks">
		{#each diagnostics.checks as check (check.id)}
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

	<div class="grids">
		<div class="block">
			<h3 class="eyebrow">Rows</h3>
			<table>
				<tbody>
					{#each diagnostics.counts as row (row.table)}
						<tr>
							<td>{row.table.replace(/_/g, ' ')}</td>
							<td class="num mono">{count(row.rows)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		<div class="block">
			<h3 class="eyebrow">Environment</h3>
			<table>
				<tbody>
					{#each diagnostics.environment as row (row.name)}
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
		font-size: 0.82rem;
	}

	@media (max-width: 720px) {
		.block + .block {
			border-left: 0;
			border-top: 1px solid var(--hairline);
		}
	}
</style>
