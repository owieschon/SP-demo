<script lang="ts">
	/*
	  Two years of monthly revenue as plain SVG bars: no chart library, one
	  rect per month, the last twelve months in a stronger tone than the
	  twelve before them. A bar for a month with a net credit (returns worth
	  more than sales) hangs below the line.

	  It earns its place under the app's own rule (docs/design-system.md)
	  because the gaps are the signal: an account that buys every month and
	  an account that buys twice a year can have the same annual figure and
	  need completely different handling, and no single number separates
	  them. The rule also demands a reference line, which is the dashed one:
	  the average month of the EARLIER twelve, so each recent bar is read
	  against what this account used to do rather than against its own best
	  month. And it demands the numbers as a table, which is underneath.
	*/
	import { count, money } from '$lib/format';
	import ChartNumbers from '$lib/components/ui/ChartNumbers.svelte';

	let { months }: { months: { month: string; revenue: number }[] } = $props();

	// The drawing is in its own coordinate space and scaled to the width of
	// whatever box it sits in (viewBox plus width: 100%).
	const W = 480;
	const H = 64;
	const GAP = 2;

	/*
	  Is there anything to draw? An account with no revenue at all used to
	  get 24 bars scaled against a fabricated maximum of $1, which looks
	  like a measurement and is not one.
	*/
	const anyRevenue = $derived(months.some((m) => m.revenue !== 0));

	const scale = $derived.by(() => {
		const highest = Math.max(0, ...months.map((m) => m.revenue));
		const lowest = Math.min(0, ...months.map((m) => m.revenue));
		/*
		  Positive and negative bars are scaled against their own half of the
		  box, so a month of net credits cannot draw outside it. Before this,
		  every bar was scaled against the full height while only 12px was
		  reserved below the axis, and the svg is overflow: visible, so a
		  large credit month drew over the caption.

		  The split follows the data: the credit half gets the share of the
		  height the worst credit month actually needs, up to a third.
		*/
		const span = highest + Math.abs(lowest);
		const belowShare = span > 0 ? Math.min(1 / 3, Math.abs(lowest) / span) : 0;
		const below = Math.round(H * belowShare);
		return { highest, lowest, top: H - below, below };
	});

	/*
	  The axis is where zero is, full stop. It used to be derived from the
	  first bar's own edge, so a negative first month put zero at the bottom
	  of that bar and every other month was read against the wrong line.
	*/
	const baseline = $derived(scale.top);

	const bars = $derived.by(() => {
		const width = months.length ? (W - GAP * (months.length - 1)) / months.length : W;
		const { highest, lowest, top, below } = scale;
		return months.map((m, i) => {
			const up = m.revenue >= 0;
			const budget = up ? top - 2 : below;
			const extent = up ? highest : Math.abs(lowest);
			const height = extent > 0 ? Math.max(1, (Math.abs(m.revenue) / extent) * budget) : 0;
			return {
				month: m.month,
				revenue: m.revenue,
				x: i * (width + GAP),
				y: up ? top - height : top,
				width,
				height,
				recent: i >= months.length - 12,
				label: `${monthName(m.month)}: ${money(m.revenue)}`
			};
		});
	});

	/*
	  Where the last twelve months begin. The two halves were told apart by
	  fill colour alone, with no divider, no legend and no labels, so the
	  comparison the chart exists for was invisible in greyscale and said
	  nothing to a screen reader.
	*/
	const splitAt = $derived(months.length > 12 ? bars[months.length - 12].x - GAP / 2 : null);

	const recentTotal = $derived(months.slice(-12).reduce((sum, m) => sum + m.revenue, 0));
	const earlierTotal = $derived(
		months.slice(0, Math.max(0, months.length - 12)).reduce((sum, m) => sum + m.revenue, 0)
	);
	/*
	  The reference line: the average month across the earlier twelve. A
	  chart of revenue by month with nothing to compare against is
	  decoration, and "its own tallest bar" is a comparison with itself.
	*/
	const earlierMonths = $derived(Math.max(0, months.length - 12));
	const reference = $derived(earlierMonths > 0 ? earlierTotal / earlierMonths : 0);
	const referenceY = $derived(
		scale.highest > 0
			? scale.top - (Math.max(0, reference) / scale.highest) * (scale.top - 2)
			: scale.top
	);
	const quietMonths = $derived(months.slice(-12).filter((m) => m.revenue === 0).length);

	const best = $derived(
		months.length === 0
			? null
			: months.reduce((top, m) => (m.revenue > top.revenue ? m : top), months[0])
	);

	// What the chart says, for anyone who cannot see it. The old label named
	// the chart ("Revenue by month for the last 24 months") and carried no
	// figure at all.
	const description = $derived.by(() => {
		if (!anyRevenue) return 'No revenue in the last 24 months.';
		const parts = [
			`Revenue by month over ${months.length} months.`,
			`Last 12 months ${money(recentTotal)}.`
		];
		if (months.length > 12) parts.push(`The 12 before them ${money(earlierTotal)}.`);
		if (reference > 0) parts.push(`An average month of the earlier twelve was ${money(reference)}.`);
		if (quietMonths > 0)
			parts.push(`${count(quietMonths)} of the last 12 months had no revenue at all.`);
		if (best && best.revenue > 0) parts.push(`Best month ${monthName(best.month)}, ${money(best.revenue)}.`);
		return parts.join(' ');
	});

	function monthName(iso: string): string {
		const [y, m] = iso.split('-').map(Number);
		return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}`;
	}
</script>

{#if !anyRevenue}
	<p class="muted none">No revenue in the last 24 months.</p>
{:else}
	<figure class="bars">
		<svg viewBox="0 0 {W} {H}" role="img" aria-label={description}>
			<line x1="0" y1={baseline} x2={W} y2={baseline} class="axis" />
			<!-- Where the last twelve months start, so the two halves the
			     colours distinguish are also separated by a line. -->
			{#if splitAt !== null}
				<line x1={splitAt} y1="0" x2={splitAt} y2={H} class="split" />
			{/if}
			<!-- The reference: what a month used to be, before the last year. -->
			{#if reference > 0}
				<line x1="0" y1={referenceY} x2={W} y2={referenceY} class="reference" />
			{/if}
			{#each bars as bar (bar.month)}
				<rect
					x={bar.x}
					y={bar.y}
					width={bar.width}
					height={bar.height}
					rx="1"
					class:recent={bar.recent}
					class:negative={bar.revenue < 0}
				>
					<title>{bar.label}</title>
				</rect>
			{/each}
		</svg>
		{#if bars.length}
			<figcaption>
				<span class="muted">{monthName(bars[0].month)}</span>
				<!-- The legend, so the comparison is readable without colour. -->
				{#if months.length > 12}
					<span class="legend">
						<span class="key earlier">{money(earlierTotal)}</span>
						then
						<span class="key later">{money(recentTotal)}</span>
					</span>
				{/if}
				<span class="muted">{monthName(bars[bars.length - 1].month)}</span>
			</figcaption>
		{/if}
		{#if reference > 0}
			<p class="t-meta muted reference-note">
				<span class="key-line" aria-hidden="true"></span>
				Dashed line: {money(reference)}, an average month before the last year.{#if quietMonths > 0}
					{count(quietMonths)} of the last 12 months had no revenue at all.{/if}
			</p>
		{/if}
		<ChartNumbers
			caption="Revenue per month, oldest first"
			headers={['Month', 'Revenue']}
			rows={months.map((m) => [monthName(m.month), money(m.revenue)])}
		/>
	</figure>
{/if}

<style>
	.bars {
		margin: 0;
		display: grid;
		gap: 4px;
	}

	svg {
		width: 100%;
		height: auto;
		overflow: visible;
	}

	rect {
		fill: var(--hairline-strong);
	}

	rect.recent {
		fill: var(--status-delivering);
	}

	rect.negative {
		fill: var(--danger);
	}

	.axis {
		stroke: var(--hairline-strong);
		stroke-width: 1;
	}

	/* The reference line the bars are read against. */
	.reference {
		stroke: var(--text-muted);
		stroke-width: 1;
		stroke-dasharray: 3 3;
	}

	.reference-note {
		display: flex;
		align-items: baseline;
		gap: 6px;
		max-width: var(--measure);
	}

	.key-line {
		flex: none;
		width: 14px;
		height: 0;
		margin-bottom: 3px;
		border-top: 1px dashed var(--text-muted);
	}

	/* The twelve-month boundary, dashed so it reads as a divider. */
	.split {
		stroke: var(--text-faint);
		stroke-width: 1;
		stroke-dasharray: 2 2;
	}

	.none {
		padding: var(--space-2) 0;
	}

	figcaption {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-2);
		font-size: var(--fs-meta);
	}

	.legend {
		display: flex;
		align-items: baseline;
		gap: 5px;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}

	/* Each half's total, in that half's own colour, with the figure beside
	   it so the colour is never the only thing carrying the comparison. */
	.key {
		font-weight: 500;
	}

	.key.earlier {
		color: var(--text-muted);
	}

	.key.later {
		color: var(--status-delivering);
	}
</style>
