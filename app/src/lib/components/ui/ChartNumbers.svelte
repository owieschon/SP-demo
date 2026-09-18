<script lang="ts">
	/*
	  The numbers behind a chart, as a real table.

	    <ChartNumbers
	      caption="Units sold per month"
	      headers={['Month', 'Units', 'Revenue']}
	      rows={months.map((m) => [monthName(m.month), count(m.units), money(m.revenue)])}
	    />

	  Not a fallback. Every chart in this app has to be readable as a table,
	  because a screen reader and an agent both read the DOM and neither can
	  read a picture, and because the one question a chart always raises is
	  "what was that month exactly?". It is a <details> so it costs nothing
	  until somebody wants it, and the table inside it is the same table the
	  rest of the app uses: scope on every header, figures right and tabular.
	*/
	let {
		caption,
		headers,
		rows,
		/** Which columns are figures, so they align right. Defaults to all but the first. */
		labelColumns = 1,
		summary = 'Show the numbers'
	}: {
		caption: string;
		headers: string[];
		rows: string[][];
		labelColumns?: number;
		summary?: string;
	} = $props();
</script>

<details class="numbers">
	<summary>{summary}</summary>
	<div class="table-wrap">
		<table class="sticky">
			<caption class="sr-only">{caption}</caption>
			<thead>
				<tr>
					{#each headers as header, i (header)}
						<th scope="col" class:num={i >= labelColumns}>{header}</th>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#each rows as row, r (r)}
					<tr>
						{#each row as cell, i (i)}
							{#if i === 0}
								<th scope="row">{cell}</th>
							{:else}
								<td class:num={i >= labelColumns}>{cell}</td>
							{/if}
						{/each}
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</details>

<style>
	.numbers {
		border-top: 1px solid var(--hairline);
	}

	summary {
		padding: 6px 0;
		font-size: var(--fs-meta);
		color: var(--text-muted);
		cursor: pointer;
		list-style-position: inside;
	}

	summary:hover {
		color: var(--text);
	}

	.table-wrap {
		max-height: 260px;
		overflow: auto;
	}

	/* A row header is a month or a name, not a figure. */
	th[scope='row'] {
		font-weight: 400;
		color: var(--text);
	}
</style>
