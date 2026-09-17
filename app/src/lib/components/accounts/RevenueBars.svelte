<script lang="ts">
	// Two years of monthly revenue as plain SVG bars: no chart library, one
	// rect per month, the last twelve months in a stronger tone than the
	// twelve before them. A bar for a month with a net credit (returns worth
	// more than sales) hangs below the line.
	import { money } from '$lib/format';

	let { months }: { months: { month: string; revenue: number }[] } = $props();

	// The drawing is in its own coordinate space and scaled to the width of
	// whatever box it sits in (viewBox plus width: 100%).
	const W = 480;
	const H = 64;
	const GAP = 2;

	const bars = $derived.by(() => {
		const biggest = Math.max(1, ...months.map((m) => Math.abs(m.revenue)));
		const width = months.length ? (W - GAP * (months.length - 1)) / months.length : W;
		// Room under the baseline only when some month is negative.
		const lowest = Math.min(0, ...months.map((m) => m.revenue));
		const below = lowest < 0 ? 12 : 0;
		const top = H - below;
		return months.map((m, i) => {
			const height = Math.max(1, (Math.abs(m.revenue) / biggest) * (top - 2));
			return {
				month: m.month,
				revenue: m.revenue,
				x: i * (width + GAP),
				y: m.revenue < 0 ? top : top - height,
				width,
				height,
				recent: i >= months.length - 12,
				label: `${monthName(m.month)}: ${money(m.revenue)}`
			};
		});
	});

	const baseline = $derived(bars.length ? bars[0].y + bars[0].height : H);

	function monthName(iso: string): string {
		const [y, m] = iso.split('-').map(Number);
		return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}`;
	}
</script>

<figure class="bars">
	<svg viewBox="0 0 {W} {H}" role="img" aria-label="Revenue by month for the last 24 months">
		<line x1="0" y1={baseline} x2={W} y2={baseline} class="axis" />
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
		<figcaption class="faint">
			<span>{monthName(bars[0].month)}</span>
			<span>{monthName(bars[bars.length - 1].month)}</span>
		</figcaption>
	{/if}
</figure>

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

	figcaption {
		display: flex;
		justify-content: space-between;
		font-size: 0.82rem;
	}
</style>
