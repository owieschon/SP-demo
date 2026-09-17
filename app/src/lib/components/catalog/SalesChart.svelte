<script lang="ts">
	// Units sold per month, as plain SVG bars: no chart library. The drawing
	// is 480 units wide and scales to its container; the text stays readable
	// because the labels sit outside the SVG, in HTML.
	import { count, money } from '$lib/format';
	import type { MonthUnits } from './types';

	let { months }: { months: MonthUnits[] } = $props();

	const WIDTH = 480;
	const HEIGHT = 120;
	const GAP = 3;

	const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

	// The tallest bar fills the height; an all-zero history still draws a baseline.
	const peak = $derived(Math.max(1, ...months.map((m) => m.units)));
	const slot = $derived(months.length > 0 ? WIDTH / months.length : WIDTH);

	const bars = $derived(
		months.map((m, i) => {
			const [year, month] = m.month.split('-').map(Number);
			// A returned part can make a month negative; draw it as empty.
			const height = Math.round((Math.max(m.units, 0) / peak) * HEIGHT);
			return {
				key: m.month,
				x: i * slot + GAP / 2,
				y: HEIGHT - height,
				width: slot - GAP,
				height,
				label: `${MONTH_NAMES[month - 1]} ${year}: ${count(m.units)} units, ${money(m.revenue)}`,
				current: i === months.length - 1
			};
		})
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

	const totalUnits = $derived(months.reduce((sum, m) => sum + m.units, 0));
</script>

<figure class="chart">
	<div class="plot">
		<span class="peak faint num">{count(peak)}</span>
		<svg
			viewBox="0 0 {WIDTH} {HEIGHT}"
			preserveAspectRatio="none"
			role="img"
			aria-label="Units sold per month for the last {months.length} months: {count(totalUnits)} in all, at most {count(peak)} in a month."
		>
			<line class="base" x1="0" y1={HEIGHT} x2={WIDTH} y2={HEIGHT} />
			{#each bars as bar (bar.key)}
				<rect class="bar" class:current={bar.current} x={bar.x} y={bar.y} width={bar.width} height={bar.height}>
					<title>{bar.label}</title>
				</rect>
			{/each}
		</svg>
	</div>
	<div class="ticks faint" aria-hidden="true">
		{#each ticks as tick (tick.key)}
			<span style:left="{tick.left}%">{tick.text}</span>
		{/each}
	</div>
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
		font-size: 0.78rem;
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

	.bar {
		fill: var(--text-faint);
		transition: fill var(--speed) var(--ease);
	}

	.bar.current {
		fill: var(--text-muted);
	}

	.bar:hover {
		fill: var(--text);
	}

	.ticks {
		position: relative;
		height: 14px;
		font-size: 0.78rem;
	}

	.ticks span {
		position: absolute;
		transform: translateX(-50%);
		white-space: nowrap;
	}

	/* Keep the first and last labels inside the box. */
	.ticks span:first-child {
		transform: none;
		left: 0 !important;
	}

	.ticks span:last-child {
		transform: none;
		left: auto !important;
		right: 0;
	}
</style>
