<script lang="ts">
	/*
	  Units sold per month, as plain SVG bars: no chart library. The drawing
	  is 480 units wide and scales to its container; the text stays readable
	  because the labels sit outside the SVG, in HTML.

	  This chart earns its place under the app's own rule (docs/design-system.md)
	  because the shape over time is the decision: a part that sells twelve a
	  month every month is stocked differently from one that sells a hundred
	  and forty twice a year, and no single number separates those two.

	  Three things the rule then requires, and all three were missing.

	  1. A reference line. The dashed line is the average month across the
	     window, so every bar is read against what this part normally does
	     rather than against the tallest bar, which is a comparison with
	     itself.
	  2. A month below zero drawn below zero. `Math.max(m.units, 0)` drew a
	     month of net returns at height zero, pixel-identical to a month with
	     no sales at all, while the hover text reported the real figure.
	  3. The numbers as a table, because a screen reader and an agent read
	     the DOM and neither can read a picture.
	*/
	import { count, money } from '$lib/format';
	import ChartNumbers from '$lib/components/ui/ChartNumbers.svelte';
	import type { MonthUnits } from './types';

	let { months }: { months: MonthUnits[] } = $props();

	const WIDTH = 480;
	const HEIGHT = 120;
	const GAP = 3;

	const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

	const slot = $derived(months.length > 0 ? WIDTH / months.length : WIDTH);
	const totalUnits = $derived(months.reduce((sum, m) => sum + m.units, 0));
	/** The reference: what a month usually is. Never the tallest bar. */
	const average = $derived(months.length > 0 ? totalUnits / months.length : 0);

	/*
	  Positive and negative months are scaled against their own half of the
	  box, so a month of net returns cannot draw outside it and cannot be
	  mistaken for a month with no sales.
	*/
	const scale = $derived.by(() => {
		const highest = Math.max(1, ...months.map((m) => m.units));
		const lowest = Math.min(0, ...months.map((m) => m.units));
		const span = highest + Math.abs(lowest);
		const belowShare = span > 0 ? Math.min(1 / 4, Math.abs(lowest) / span) : 0;
		const below = Math.round(HEIGHT * belowShare);
		return { highest, lowest, top: HEIGHT - below, below };
	});

	const bars = $derived(
		months.map((m, i) => {
			const [year, month] = m.month.split('-').map(Number);
			const { highest, lowest, top, below } = scale;
			const up = m.units >= 0;
			const budget = up ? top - 2 : below;
			const extent = up ? highest : Math.abs(lowest);
			const height = extent > 0 ? Math.max(m.units === 0 ? 0 : 1, (Math.abs(m.units) / extent) * budget) : 0;
			return {
				key: m.month,
				x: i * slot + GAP / 2,
				y: up ? top - height : top,
				width: slot - GAP,
				height,
				negative: m.units < 0,
				label: `${MONTH_NAMES[month - 1]} ${year}: ${count(m.units)} units, ${money(m.revenue)}`,
				current: i === months.length - 1
			};
		})
	);

	/** Where the average line sits, in the drawing's own coordinates. */
	const averageY = $derived(
		scale.highest > 0 ? scale.top - (Math.max(0, average) / scale.highest) * (scale.top - 2) : scale.top
	);

	// Axis labels under the chart: the first month, each January, and the last.
	const ticks = $derived(
		months.flatMap((m, i) => {
			const [year, month] = m.month.split('-').map(Number);
			const show = i === 0 || month === 1 || i === months.length - 1;
			if (!show) return [];
			return [
				{
					key: m.month,
					left: ((i + 0.5) / months.length) * 100,
					text: `${MONTH_NAMES[month - 1]} ${String(year).slice(2)}`
				}
			];
		})
	);

	const lastMonth = $derived(months.length > 0 ? months[months.length - 1] : null);
	const quiet = $derived(months.filter((m) => m.units === 0).length);

	/*
	  What the chart says, for anyone who cannot see it, and the sentence
	  under it for everybody else. It leads with the comparison because the
	  comparison is the point.
	*/
	const verdict = $derived.by(() => {
		if (months.length === 0) return 'No sales history.';
		if (totalUnits === 0) return `Nothing sold in ${months.length} months.`;
		const parts = [
			`${count(totalUnits)} units over ${months.length} months, ${count(Math.round(average))} in an average month.`
		];
		if (lastMonth) {
			const versus =
				lastMonth.units > average
					? 'above that average'
					: lastMonth.units < average
						? 'below it'
						: 'exactly at it';
			parts.push(`Last month ${count(lastMonth.units)}, ${versus}.`);
		}
		if (quiet > 0) parts.push(`${count(quiet)} months with no sales at all.`);
		return parts.join(' ');
	});

	function monthName(iso: string): string {
		const [y, m] = iso.split('-').map(Number);
		return `${MONTH_NAMES[m - 1]} ${y}`;
	}
</script>

<figure class="chart">
	<div class="plot">
		<span class="peak muted num">{count(scale.highest)}</span>
		<svg viewBox="0 0 {WIDTH} {HEIGHT}" preserveAspectRatio="none" role="img" aria-label={verdict}>
			<line class="base" x1="0" y1={scale.top} x2={WIDTH} y2={scale.top} />
			<!-- The reference line: what a month usually is. -->
			<line class="average" x1="0" y1={averageY} x2={WIDTH} y2={averageY} />
			{#each bars as bar (bar.key)}
				<rect
					class="bar"
					class:current={bar.current}
					class:negative={bar.negative}
					x={bar.x}
					y={bar.y}
					width={bar.width}
					height={bar.height}
				>
					<title>{bar.label}</title>
				</rect>
			{/each}
		</svg>
	</div>
	<div class="ticks muted" aria-hidden="true">
		{#each ticks as tick (tick.key)}
			<span style:left="{tick.left}%">{tick.text}</span>
		{/each}
	</div>
	<figcaption class="t-meta muted">
		<span class="key" aria-hidden="true"></span>
		Dashed line: {count(Math.round(average))} units, the average month. {verdict}
	</figcaption>
	<ChartNumbers
		caption="Units and revenue per month, oldest first"
		headers={['Month', 'Units', 'Revenue']}
		rows={months.map((m) => [monthName(m.month), count(m.units), money(m.revenue)])}
	/>
</figure>

<style>
	.chart {
		margin: 0;
		display: grid;
		gap: 4px;
	}

	.plot {
		position: relative;
		padding-top: 14px;
	}

	.peak {
		position: absolute;
		top: 0;
		left: 0;
		font-size: var(--fs-meta);
	}

	svg {
		display: block;
		width: 100%;
		height: 120px;
		overflow: visible;
	}

	.base {
		stroke: var(--hairline-strong);
		stroke-width: 1;
		vector-effect: non-scaling-stroke;
	}

	/* The reference the bars are read against. Dashed, so it is never
	   mistaken for a bar, and named in the caption. */
	.average {
		stroke: var(--text-muted);
		stroke-width: 1;
		stroke-dasharray: 3 3;
		vector-effect: non-scaling-stroke;
	}

	.bar {
		fill: var(--text-faint);
		transition: fill var(--speed) var(--ease);
	}

	/* The most recent month, which is the one being judged. */
	.bar.current {
		fill: var(--status-delivering);
	}

	/* A month of net returns. It hangs below the line and it is the only
	   thing on the chart in this colour. */
	.bar.negative {
		fill: var(--danger);
	}

	.bar:hover {
		fill: var(--text);
	}

	.ticks {
		position: relative;
		height: 14px;
		font-size: var(--fs-meta);
	}

	.ticks span {
		position: absolute;
		transform: translateX(-50%);
		white-space: nowrap;
	}

	/*
	  Keep the first and last labels inside the box. With one tick a single
	  span is both the first child and the last, and :last-child used to win
	  and pin the only label to the wrong edge; :first-child now wins.
	*/
	.ticks span:last-child {
		transform: none;
		left: auto !important;
		right: 0;
	}

	.ticks span:first-child {
		transform: none;
		left: 0 !important;
		right: auto;
	}

	figcaption {
		display: flex;
		align-items: baseline;
		gap: 6px;
		max-width: var(--measure);
	}

	.key {
		flex: none;
		width: 14px;
		height: 0;
		margin-bottom: 3px;
		border-top: 1px dashed var(--text-muted);
	}
</style>
