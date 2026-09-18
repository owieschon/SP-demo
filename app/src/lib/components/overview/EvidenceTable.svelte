<script lang="ts">
	/*
	  The last link in the chain: the rows that produced a number.

	  The server names the numbers on each row, so this table takes its column
	  headers from the first row rather than being told them twice. That is the
	  only reason it can be one component for invoice lines, invoices and
	  anything else the drill-down reaches.
	*/
	import { count, money, moneyExact, percent } from '$lib/format';
	import DataTable from '$lib/components/ui/DataTable.svelte';
	import type { EvidenceRow } from '$lib/server/overview/types';

	let {
		rows,
		/** What these rows are, as a sentence. It becomes the caption. */
		caption,
		/** What the first column holds: 'Invoice', 'Run'. */
		refHeader = 'Reference',
		labelHeader = 'What'
	}: { rows: EvidenceRow[]; caption: string; refHeader?: string; labelHeader?: string } = $props();

	const numberColumns = $derived(rows[0]?.numbers.map((n) => n.label) ?? []);

	const columns = $derived([
		{ key: 'ref', header: refHeader },
		{ key: 'on', header: 'Posted' },
		{ key: 'label', header: labelHeader },
		...numberColumns.map((header) => ({ key: `n-${header}`, header, align: 'right' as const })),
		{ key: 'go', header: 'Record', hideHeader: true }
	]);

	// A cent figure rather than a rounded one: this is the arithmetic, and a
	// column of rounded dollars that does not add up to the total is worse
	// than a column that is hard to skim.
	function show(value: number, unit: string): string {
		if (unit === 'money') return Math.abs(value) < 1000 ? moneyExact(value) : money(value);
		if (unit === 'percent') return percent(value);
		return count(value);
	}
</script>

<DataTable
	{columns}
	{rows}
	rowKey={(row: EvidenceRow) => row.key}
	{caption}
	shown={rows.length}
	total={rows.length}
	noun="rows"
	order="newest first"
	emptyLine="Nothing behind this one."
>
	{#snippet row(evidence: EvidenceRow)}
		<td class="mono">{evidence.ref}</td>
		<td>{evidence.on}</td>
		<td>{evidence.label}</td>
		{#each evidence.numbers as figure (figure.label)}
			<td class="num">{show(figure.value, figure.unit)}</td>
		{/each}
		<td>
			{#if evidence.href}
				<a class="link" href={evidence.href}>{evidence.hrefLabel ?? 'Open'}</a>
			{/if}
		</td>
	{/snippet}
</DataTable>
