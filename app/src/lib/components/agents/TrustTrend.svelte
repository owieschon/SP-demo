<script lang="ts">
	/*
	  The one chart on /agents: approval rate and edit rate week by week, with
	  the promotion threshold drawn across as a reference line, and the
	  guardrail refusals as a count band underneath.

	  Three decisions worth stating.

	  1. It is ONE chart, because the house rule is at most one chart per
	     screen. Approval rate and edit rate share an axis honestly (both are
	     a share of decided runs), so they belong together; the refusals are a
	     count, so they get their own band rather than a second y axis, which
	     would put two units on one scale and invite a false comparison.
	  2. It reads as a table as well, and the table is VISIBLE rather than
	     sr-only. Agents read these screens too, and a screen reader is not
	     the only thing that cannot see an SVG. The table is the primary
	     artifact; the drawing is the summary of it.
	  3. The reference line is labelled in words. A dashed line at 0.9 means
	     nothing on its own; "90%, what a promotion asks for" means something.

	  Plain SVG, no chart library, same as $lib/components/catalog/SalesChart.
	*/
	import { percent } from '$lib/format';
	import type { TrustTrend } from '$lib/server/harness/trust';

	let { trend, label }: { trend: TrustTrend; label: string } = $props();

	const WIDTH = 560;
	const RATES_H = 140;
	const BAND_H = 34;

	const weeks = $derived(trend.weeks);
	const slot = $derived(weeks.length > 0 ? WIDTH / weeks.length : WIDTH);

	/** A rate to a y coordinate in the top band. 0% at the bottom, 100% at the top. */
	const y = (rate: number) => RATES_H - rate * RATES_H;

	/** Only the weeks somebody actually decided something can carry a rate. */
	const points = $derived(
		weeks.map((w, i) => ({
			key: w.weekOf,
			x: i * slot + slot / 2,
			approval: w.approvalRate,
			edit: w.editRate,
			week: w
		}))
	);

	/** An SVG path through the weeks that have a value, skipping the ones that do not. */
	function pathOf(pick: (p: (typeof points)[number]) => number | null): string {
		const out: string[] = [];
		let open = false;
		for (const p of points) {
			const value = pick(p);
			if (value === null) {
				open = false;
				continue;
			}
			out.push(`${open ? 'L' : 'M'}${p.x.toFixed(1)} ${y(value).toFixed(1)}`);
			open = true;
		}
		return out.join(' ');
	}

	const approvalPath = $derived(pathOf((p) => p.approval));
	const editPath = $derived(pathOf((p) => p.edit));

	// The refusal band scales to its own tallest week, and a week with none
	// draws nothing at all rather than a one-pixel sliver that reads as one.
	const peakRefusals = $derived(Math.max(1, ...weeks.map((w) => w.refusals)));

	const bars = $derived(
		weeks.map((w, i) => {
			const height = w.refusals === 0 ? 0 : Math.max(2, (w.refusals / peakRefusals) * BAND_H);
			return {
				key: w.weekOf,
				x: i * slot + slot * 0.2,
				width: slot * 0.6,
				y: BAND_H - height,
				height,
				refusals: w.refusals
			};
		})
	);

	const anyDecided = $derived(weeks.some((w) => w.reviewed > 0));
	const totalRuns = $derived(weeks.reduce((sum, w) => sum + w.runs, 0));
	const totalRefusals = $derived(weeks.reduce((sum, w) => sum + w.refusals, 0));

	/** The last bucket is the week in progress, and saying so stops it reading as a fall. */
	const lastIndex = $derived(weeks.length - 1);

	function weekLabel(iso: string): string {
		const [, month, dayOfMonth] = iso.split('-');
		return `${Number(month)}/${Number(dayOfMonth)}`;
	}

	const description = $derived(
		weeks.length === 0
			? `No runs for ${label} in the last eight weeks.`
			: `${label}: ${totalRuns} runs over ${weeks.length} week${weeks.length === 1 ? '' : 's'}, ` +
				`${totalRefusals} guardrail refusal${totalRefusals === 1 ? '' : 's'}. ` +
				(anyDecided
					? `Approval rate went from ${rateWords(weeks[0].approvalRate)} to ${rateWords(weeks[lastIndex].approvalRate)}.`
					: 'Nobody has decided one of these yet, so there is no approval rate to plot.') +
				(trend.threshold === null ? '' : ` The reference line is ${percent(trend.threshold)}.`)
	);

	function rateWords(rate: number | null): string {
		return rate === null ? 'nothing yet' : percent(rate);
	}
</script>

{#if weeks.length === 0}
	<p class="empty">
		<span>No runs in the last eight weeks, so there is no trend yet for {label}.</span>
	</p>
{:else}
	<figure>
		<svg
			viewBox="0 0 {WIDTH} {RATES_H + BAND_H + 10}"
			preserveAspectRatio="none"
			role="img"
			aria-label={description}
		>
			<!-- The gridlines a rate is read against: nothing, half, all. -->
			{#each [0, 0.5, 1] as line (line)}
				<line class="grid" x1="0" y1={y(line)} x2={WIDTH} y2={y(line)} />
			{/each}

			{#if trend.threshold !== null}
				<line
					class="threshold"
					x1="0"
					y1={y(trend.threshold)}
					x2={WIDTH}
					y2={y(trend.threshold)}
				/>
			{/if}

			{#if anyDecided}
				<path class="series approval" d={approvalPath} />
				<path class="series edit" d={editPath} />
				{#each points as p (p.key)}
					{#if p.approval !== null}
						<circle class="dot approval" cx={p.x} cy={y(p.approval)} r="3" />
					{/if}
					{#if p.edit !== null}
						<circle class="dot edit" cx={p.x} cy={y(p.edit)} r="3" />
					{/if}
				{/each}
			{/if}

			<!-- The refusal band, on its own scale under its own baseline. -->
			<g transform="translate(0 {RATES_H + 10})">
				<line class="grid" x1="0" y1={BAND_H} x2={WIDTH} y2={BAND_H} />
				{#each bars as bar (bar.key)}
					{#if bar.height > 0}
						<rect class="refusal" x={bar.x} y={bar.y} width={bar.width} height={bar.height}>
							<title>{bar.refusals} refused, week of {bar.key}</title>
						</rect>
					{/if}
				{/each}
			</g>
		</svg>

		<div class="ticks faint" aria-hidden="true">
			{#each weeks as week, i (week.weekOf)}
				<span style:left="{((i + 0.5) / weeks.length) * 100}%">{weekLabel(week.weekOf)}</span>
			{/each}
		</div>

		<p class="t-meta muted key">
			<span class="swatch approval"></span> Approval rate
			<span class="swatch edit"></span> Edit rate
			<span class="swatch refusal"></span> Refusals, on their own scale
			{#if trend.threshold !== null}
				<span class="swatch threshold"></span> {trend.thresholdWords}
			{/if}
		</p>

		<figcaption class="t-meta muted">
			{description}
			{#if weeks.length > 1}
				The last week is still running, so its figures are partial.
			{/if}
		</figcaption>
	</figure>

	<div class="table-wrap">
		<table>
			<caption class="sr-only">
				{label}: runs, approval rate, edit rate and guardrail refusals, week by week
			</caption>
			<thead>
				<tr>
					<th scope="col">Week of</th>
					<th scope="col" class="num">Runs</th>
					<th scope="col" class="num">Decided</th>
					<th scope="col" class="num">Approval rate</th>
					<th scope="col" class="num">Edit rate</th>
					<th scope="col" class="num">Refused</th>
				</tr>
			</thead>
			<tbody>
				{#each weeks as week, i (week.weekOf)}
					<tr>
						<th scope="row">
							{week.weekOf}
							{#if i === lastIndex && weeks.length > 1}<span class="t-meta muted">still running</span>{/if}
						</th>
						<td class="num">{week.runs}</td>
						<td class="num">{week.reviewed}</td>
						<td class="num">
							{#if week.approvalRate === null}
								<span class="muted">nothing decided</span>
							{:else}
								{percent(week.approvalRate)}
								{#if trend.threshold !== null && week.approvalRate < trend.threshold}
									<span class="t-meta muted">under the line</span>
								{/if}
							{/if}
						</td>
						<td class="num">
							{#if week.editRate === null}
								<span class="muted">nothing let through</span>
							{:else}
								{percent(week.editRate)}
							{/if}
						</td>
						<td class="num">{week.refusals}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}

<style>
	figure {
		margin: 0 0 var(--space-3);
		display: grid;
		gap: var(--space-2);
	}

	svg {
		display: block;
		width: 100%;
		height: 184px;
		overflow: visible;
	}

	.grid {
		stroke: var(--hairline);
		stroke-width: 1;
		vector-effect: non-scaling-stroke;
	}

	.threshold {
		stroke: var(--warning);
		stroke-width: 1;
		stroke-dasharray: 4 3;
		vector-effect: non-scaling-stroke;
	}

	.series {
		fill: none;
		stroke-width: 2;
		vector-effect: non-scaling-stroke;
	}

	.series.approval,
	.dot.approval {
		stroke: var(--text);
	}

	.dot.approval {
		fill: var(--text);
	}

	/* The edit rate is the same kind of thing as the approval rate, so it is
	   the same shape in a quieter ink rather than a different shape. */
	.series.edit {
		stroke: var(--text-faint);
		stroke-dasharray: 5 3;
	}

	.dot.edit {
		fill: var(--bg);
		stroke: var(--text-faint);
	}

	.refusal {
		fill: var(--danger);
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

	.ticks span:first-child {
		transform: none;
		left: 0 !important;
	}

	.ticks span:last-child {
		transform: none;
		left: auto !important;
		right: 0;
	}

	.key {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-1) var(--space-3);
	}

	.swatch {
		display: inline-block;
		width: 14px;
		height: 3px;
		border-radius: 2px;
		margin-right: var(--space-1);
	}

	.swatch.approval {
		background: var(--text);
	}

	.swatch.edit {
		background: var(--text-faint);
	}

	.swatch.refusal {
		background: var(--danger);
		height: 8px;
		width: 8px;
	}

	.swatch.threshold {
		background: var(--warning);
	}
</style>
