<script lang="ts">
	// The trace: every policy that could have answered, the one that did, and
	// the reason each of the others did not. The built-in default is always
	// the last row, whether it won or not.
	import Check from '@lucide/svelte/icons/check';
	import { day } from '$lib/format';
	import { SCOPE_LABEL, type PolicyScopeKind, type PolicyTraceRow } from '$lib/policy/types';

	let {
		rows,
		year
	}: {
		rows: PolicyTraceRow[];
		year: number;
	} = $props();

	function scopeWords(row: PolicyTraceRow): string {
		if (row.scopeKind === 'default') return 'Built-in default';
		if (row.scopeKind === 'global') return 'Everyone';
		const label = SCOPE_LABEL[row.scopeKind as PolicyScopeKind] ?? row.scopeKind;
		return row.scopeId === '' ? label : `${label} ${row.scopeId}`;
	}

	function windowWords(row: PolicyTraceRow): string {
		if (row.effectiveFrom === null) return 'always';
		const from = day(row.effectiveFrom, year);
		return row.effectiveTo === null ? `from ${from}` : `${from} to ${day(row.effectiveTo, year)}`;
	}
</script>

<div class="table-wrap" tabindex="-1">
	<table>
		<thead>
			<tr>
				<th scope="col"><span class="sr-only">Winner</span></th>
				<th scope="col">Set at</th>
				<th scope="col">Value</th>
				<th scope="col">In force</th>
				<th scope="col" class="num">Priority</th>
				<th scope="col">What happened</th>
			</tr>
		</thead>
		<tbody>
			{#each rows as row (row.policyId ?? 'default')}
				<tr class:is-selected={row.isWinner}>
					<td class="mark">
						{#if row.isWinner}
							<Check size={14} strokeWidth={2} aria-label="This one won" />
						{/if}
					</td>
					<th scope="row">{scopeWords(row)}</th>
					<td><strong>{row.valueWords}</strong></td>
					<td class="nowrap faint">{windowWords(row)}</td>
					<td class="num faint">{row.priority ?? '·'}</td>
					<td class="why">
						{row.reason}
						{#if row.note !== ''}
							<span class="faint">{row.note}</span>
						{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<style>
	.mark {
		width: 28px;
		color: var(--status-kept);
	}

	th[scope='row'] {
		font-weight: 500;
		color: var(--text);
		border-bottom: 1px solid var(--hairline);
		white-space: normal;
	}

	.why {
		display: grid;
		gap: 1px;
		font-size: var(--fs-meta);
		max-width: 44ch;
		white-space: normal;
	}

	.nowrap {
		white-space: nowrap;
	}
</style>
