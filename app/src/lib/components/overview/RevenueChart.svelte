<script lang="ts">
	/*
	  The one chart this page is allowed, and it carries a reference line or it
	  would be decoration: a bar per month for the last thirteen months, and a
	  stepped line across them at the same month a year earlier.

	  Plain SVG, one rect per month, the same way RevenueBars does it on the
	  account page. No chart library, and nothing here that Safari on iOS draws
	  differently from Chrome.

	  Three things the chart says in words as well as in ink, because colour on
	  its own says nothing in greyscale or to a screen reader: the two totals in
	  the caption, the months at either end, and a full sentence in aria-label.
	  The month in progress is drawn but marked, because comparing a month we
	  are eleven days into against a whole month a year ago is how a chart
	  starts lying.
	*/
	import { money } from '$lib/format';
	import type { MonthPoint } from '$lib/server/overview/types';

	let { months, href }: { months: MonthPoint[]; href: string } = $props();

	const W = 720;
	const H = 120;
	const GAP = 3;

	const anyRevenue = $derived(months.some((m) => m.revenue !== 0 || m.priorRevenue !== 0));

	// Both series share one scale, or the reference line would mean nothing.
	const top = $derived(
		Math.max(1, ...months.map((m) => Math.max(m.revenue, m.priorRevenue)))
	);

	const barWidth = $derived(
		months.length ? (W - GAP * (months.length - 1)) / months.length : W
	);

	const bars = $derived(
		months.map((m, i) => {
			const height = Math.max(1, (Math.max(m.revenue, 0) / top) * (H - 2));
			return {
				...m,
				x: i * (barWidth + GAP),
				y: H - height,
				width: barWidth,
				height,
				// Where the reference line sits for this month.
				refY: H - Math.max(1, (Math.max(m.priorRevenue, 0) / top) * (H - 2))
			};
		})
	);

	/*
	  The reference line as one stepped path: flat across each month, so it
	  reads as "the level to beat this month" rather than as a second series
	  somebody might try to read a trend off.
	*/
	const refPath = $derived(
		bars
			.map((bar, i) => `${i === 0 ? 'M' : 'L'} ${bar.x} ${bar.refY} L ${bar.x + bar.width} ${bar.refY}`)
			.join(' ')
	);

	const closed = $derived(months.filter((m) => !m.partial));
	const thisYear = $derived(closed.reduce((sum, m) => sum + m.revenue, 0));
	const lastYear = $derived(closed.reduce((sum, m) => sum + m.priorRevenue, 0));
	const ahead = $derived(closed.filter((m) => m.revenue >= m.priorRevenue).length);

	const description = $derived(
		anyRevenue
			? `Revenue by month for ${months.length} months, against the same month a year earlier. ` +
				`Over the ${closed.length} completed months, ${money(thisYear)} against ${money(lastYear)}. ` +
				`${ahead} of ${closed.length} months beat their own month last year.`
			: 'No revenue in the last thirteen months.'
	);

	function label(iso: string): string {
		const [year, month] = iso.split('-').map(Number);
		const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
		return `${names[month - 1]} ${year}`;
	}
</script>

{#if !anyRevenue}
	<p class="muted">No revenue in the last thirteen months.</p>
{:else}
	<figure>
		<svg viewBox="0 0 {W} {H}" role="img" aria-label={description} preserveAspectRatio="none">
			{#each bars as bar (bar.month)}
				<rect
					x={bar.x}
					y={bar.y}
					width={bar.width}
					height={bar.height}
					rx="1"
					class:partial={bar.partial}
					class:behind={!bar.partial && bar.revenue < bar.priorRevenue}
				>
					<title>
						{label(bar.month)}: {money(bar.revenue)}, against {money(bar.priorRevenue)} a year
						earlier{bar.partial ? ' (this month is not finished)' : ''}
					</title>
				</rect>
			{/each}
			<!-- The reference line last, so it sits on top of the bars. -->
			<path d={refPath} class="reference" />
		</svg>
		<figcaption>
			<span class="muted">{label(months[0].month)}</span>
			<span class="legend">
				<span class="key bar">{money(thisYear)}</span>
				against
				<span class="key ref">{money(lastYear)}</span>
				a year earlier, over {closed.length} completed months
			</span>
			<span class="muted">
				{label(months[months.length - 1].month)}
				{#if months[months.length - 1].partial}<span class="faint">so far</span>{/if}
			</span>
		</figcaption>
	</figure>
	<!-- Outside the figure, because a figcaption has to be the figure's first
	     or last child and the legend has earned that place. -->
	<p class="t-meta muted explain">
		The line is the same month a year earlier.
		<a class="link" {href}>Every month, and what changed</a>
	</p>
{/if}

<style>
	figure {
		margin: 0;
		display: grid;
		gap: 6px;
	}

	.explain {
		margin: 6px 0 0;
	}

	svg {
		width: 100%;
		height: 120px;
	}

	rect {
		fill: var(--status-delivering);
	}

	/* Behind its own month last year: said with a word in the tooltip and the
	   caption as well as with this colour. */
	rect.behind {
		fill: var(--warning);
	}

	/* The month in progress is not a fair comparison, so it is drawn faint. */
	rect.partial {
		fill: var(--hairline-strong);
	}

	.reference {
		fill: none;
		stroke: var(--text);
		stroke-width: 1.5;
		stroke-dasharray: 5 3;
		vector-effect: non-scaling-stroke;
	}

	figcaption {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-2);
		flex-wrap: wrap;
		font-size: var(--fs-meta);
	}

	.legend {
		display: flex;
		align-items: baseline;
		gap: 5px;
		flex-wrap: wrap;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}

	.key {
		font-weight: 500;
	}

	.key.bar {
		color: var(--status-delivering);
	}

	.key.ref {
		color: var(--text);
	}

	.faint {
		color: var(--text-faint);
	}
</style>
