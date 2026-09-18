<script lang="ts">
	/*
	  Coverage: what we know, what has gone stale, and what is missing, per
	  subject kind and attribute, worst first.

	  The last column is the one that matters. A missing count is not a
	  statistic, it is a work list, so each row carries the control that goes
	  and looks. Ordering by coverage means the row at the top is the one to
	  press.
	*/
	import { enhance } from '$app/forms';
	import SubmitButton from '$lib/components/ui/SubmitButton.svelte';
	import { routes } from '$lib/routes';
	import { SURFACE_LABEL, type CoverageRow, type CoverageGap, type Surface } from '$lib/context/types';

	let {
		rows,
		/** The worst offenders per row, keyed 'kind|attribute'. */
		gaps,
		requestId
	}: {
		rows: CoverageRow[];
		gaps: Record<string, CoverageGap[]>;
		requestId: string;
	} = $props();

	let open = $state<string | null>(null);
	let working = $state<string | null>(null);

	function key(row: CoverageRow): string {
		return `${row.subject_kind}|${row.attribute}`;
	}

	/** A bar is a picture of one number; the number is beside it in words. */
	function barWidth(row: CoverageRow): string {
		return `${Math.max(row.coverage_pct, 1.5)}%`;
	}

	function surfaceWords(surfaces: Surface[] | undefined): string {
		if (!surfaces || surfaces.length === 0) return '';
		return surfaces.map((surface) => SURFACE_LABEL[surface] ?? surface).join(', ');
	}
</script>

<div class="table-wrap">
	<table>
		<thead>
			<tr>
				<th scope="col">What we would like to know</th>
				<th scope="col">About</th>
				<th scope="col" class="num">Verified</th>
				<th scope="col" class="num">Stale</th>
				<th scope="col" class="num">Missing</th>
				<th scope="col">Covered</th>
				<th scope="col"><span class="sr-only">Go and look</span></th>
			</tr>
		</thead>
		<tbody>
			{#each rows as row (key(row))}
				<tr class:is-selected={open === key(row)}>
					<th scope="row">
						<span class="label">{row.label}</span>
						<span class="t-meta muted mono">{row.attribute}</span>
						{#if row.disclosure === 'internal'}
							<span class="chip">internal only</span>
						{/if}
					</th>
					<td>{row.subject_kind}</td>
					<td class="num">{row.verified}</td>
					<td class="num" class:negative={row.stale > 0}>{row.stale}</td>
					<td class="num" class:negative={row.missing > 0}>{row.missing}</td>
					<td>
						<div class="bar" role="img" aria-label="{row.coverage_pct}% of {row.subjects} covered">
							<span style:width={barWidth(row)}></span>
						</div>
						<span class="t-meta muted">
							{row.coverage_pct}% of {row.subjects}
						</span>
					</td>
					<td class="right">
						<button
							type="button"
							class="button sm"
							aria-expanded={open === key(row)}
							onclick={() => (open = open === key(row) ? null : key(row))}
						>
							{open === key(row) ? 'Hide' : 'Who'}
						</button>
					</td>
				</tr>
				{#if open === key(row)}
					<tr class="detail">
						<td colspan="7">
							{#if (gaps[key(row)] ?? []).length === 0}
								<p class="t-meta muted">
									Nothing is missing this one, or the gap list has not been loaded for it.
								</p>
							{:else}
								<p class="t-meta muted">
									The ones that matter most and have no fresh answer, heaviest first.
									{#if row.disclosure === 'internal'}
										This one never leaves the building, whichever screen shows it.
									{/if}
								</p>
								<ul class="rows">
									{#each gaps[key(row)] as gap (gap.subject_id)}
										<li>
											<a class="link" href={routes.contextFor(row.subject_kind, gap.subject_id)}>
												{gap.name ?? gap.subject_id}
											</a>
											<span class="t-meta muted">
												{gap.state}{#if gap.stale_days}, {gap.stale_days} days past its horizon{/if}
											</span>
											<form
												method="POST"
												action="{routes.context()}?/explore"
												use:enhance={() => {
													working = `${key(row)}|${gap.subject_id}`;
													return async ({ update }) => {
														working = null;
														await update({ reset: false });
													};
												}}
											>
												<input type="hidden" name="entityKind" value={row.subject_kind} />
												<input type="hidden" name="entityId" value={gap.subject_id} />
												<input type="hidden" name="attribute" value={row.attribute} />
												<input
													type="hidden"
													name="requestId"
													value="{requestId}-{row.attribute}-{gap.subject_id}"
												/>
												<SubmitButton
													label="Go and look"
													workingLabel="Looking"
													working={working === `${key(row)}|${gap.subject_id}`}
													record="{row.label} for {gap.name ?? gap.subject_id}"
													tone="plain"
												/>
											</form>
										</li>
									{/each}
								</ul>
							{/if}
							{#if surfaceWords(undefined)}
								<p class="t-meta muted">Used for: {surfaceWords(undefined)}</p>
							{/if}
						</td>
					</tr>
				{/if}
			{/each}
		</tbody>
	</table>
</div>

<style>
	.label {
		display: block;
		font-weight: 500;
	}

	.mono {
		display: block;
	}

	.right {
		text-align: right;
	}

	/* Flexbox rather than grid: mobile Safari and Chromium disagree about
	   grid in a table cell, and this only needs one axis. */
	.bar {
		display: flex;
		width: 96px;
		height: 6px;
		border-radius: 3px;
		background: var(--hairline);
		overflow: hidden;
	}

	.bar > span {
		display: block;
		background: var(--text);
		border-radius: 3px;
	}

	.detail td {
		padding: var(--space-3);
		background: var(--surface-sunken, transparent);
	}

	.detail .rows > li {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		flex-wrap: wrap;
		padding: 6px 0;
	}

	.detail .rows > li > form {
		margin-left: auto;
	}
</style>
