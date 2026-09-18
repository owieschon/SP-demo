<script lang="ts">
	// The live open lines: four buckets, the lines that need attention, what
	// changed since the last export, and the recent snapshots.
	import Blank from '$lib/components/ui/Blank.svelte';
	import { count, day, moment, money } from '$lib/format';
	import {
		BUCKET_LABEL,
		EXPORT_KIND_LABEL,
		type Bucket,
		type LineChange,
		type OperationsBoard,
		type SnapshotStatus
	} from './types';

	let { board, year }: { board: OperationsBoard; year: number } = $props();

	const BUCKET_HINT: Record<Bucket, string> = {
		past_due: 'Ship date has passed',
		at_risk: 'Due soon, stock does not cover it',
		on_pace: 'Due soon, stock covers it',
		later: 'Due after that'
	};

	const CHANGE_LABEL: Record<LineChange, string> = {
		new: 'New',
		shipped: 'Gone',
		newly_short: 'Newly short'
	};

	const STATUS_LABEL: Record<SnapshotStatus, string> = {
		staged: 'Waiting',
		held: 'Held',
		applied: 'Applied',
		discarded: 'Discarded'
	};

	const HOLD_LABEL = { partial: 'partial', stale: 'stale', row_errors: 'row errors' } as const;

	// Each bucket's share of all open lines, for the thin bar.
	const shares = $derived(
		board.buckets.map((b) => ({ bucket: b.bucket, share: board.totals.lines ? b.lines / board.totals.lines : 0 }))
	);
	const horizonEnds = $derived.by(() => {
		const date = new Date(`${board.today}T00:00:00Z`);
		date.setUTCDate(date.getUTCDate() + board.horizonDays);
		return date.toISOString().slice(0, 10);
	});
</script>

<section class="panel" aria-labelledby="buckets-title">
	<header class="panel-head">
		<h2 id="buckets-title">Open lines</h2>
		<span class="faint">
			{#if board.current}
				From snapshot
				<a class="link" href="/operations?snapshot={board.current.id}">#{board.current.id}</a>,
				applied {moment(board.current.appliedAt)} by {board.current.appliedBy}
			{:else}
				Nothing applied yet
			{/if}
		</span>
	</header>

	{#if !board.current}
		<p class="body muted">
			No export has been applied yet. Download yesterday's sample above, upload it and apply it, then do the
			same with today's.
		</p>
	{:else}
		<dl class="figures">
			{#each board.buckets as b (b.bucket)}
				<div class="figure" style:--tone="var(--bucket-{b.bucket})">
					<dt><span class="swatch" aria-hidden="true"></span>{BUCKET_LABEL[b.bucket]}</dt>
					<dd>
						<span class="big num">{count(b.lines)}</span>
						<span class="muted small">lines</span>
					</dd>
					<dd class="small">
						<span class="num">{count(b.quantity)}</span> pcs · <span class="num">{money(b.value)}</span>
					</dd>
					<dd class="small" class:short={b.short > 0}>
						{#if b.short > 0}<span class="num">{count(b.short)}</span> pcs short{:else}Fully covered{/if}
					</dd>
					<dd class="faint small">{BUCKET_HINT[b.bucket]}</dd>
				</div>
			{/each}
		</dl>
		<div class="share" aria-hidden="true">
			{#each shares as s (s.bucket)}
				<span style:--tone="var(--bucket-{s.bucket})" style:flex-grow={String(s.share)}></span>
			{/each}
		</div>
		<p class="body faint small">
			{count(board.totals.lines)} open lines, {count(board.totals.quantity)} pieces, {money(board.totals.value)}.
			Stock goes to the oldest ship date first. "Due soon" is through {day(horizonEnds, year)}
			({board.horizonDays} days).
		</p>
	{/if}
</section>

{#if board.current}
	<section class="panel" aria-labelledby="risk-title">
		<header class="panel-head">
			<h2 id="risk-title">Past due and at risk</h2>
			<span class="faint num">
				{#if board.riskLineCount > board.riskLines.length}
					{board.riskLines.length} of {count(board.riskLineCount)}
				{:else}
					{count(board.riskLineCount)}
				{/if}
				<!-- This panel answers "is there stock today". The forecast answers
				     "when will it ship, and because of which supply order". -->
				<a class="link" href="/operations/forecast">When will these ship?</a>
			</span>
		</header>
		{#if board.riskLines.length === 0}
			<p class="body muted">Nothing is late or short in the next {board.horizonDays} days.</p>
		{:else}
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th scope="col">Customer</th>
							<th scope="col">Item</th>
							<th scope="col">Order</th>
							<th scope="col">Ships</th>
							<th scope="col" class="num">Qty</th>
							<th scope="col" class="num">Short</th>
						</tr>
					</thead>
					<tbody>
						{#each board.riskLines as l (l.documentNo + ':' + l.lineNo)}
							<tr>
								<td class="customer">
									<span class="swatch" style:--tone="var(--bucket-{l.bucket})" title={BUCKET_LABEL[l.bucket]}></span>
									{l.customerName}
								</td>
								<td>
									<span class="mono">{l.itemNo}</span>
									<span class="faint desc">{l.description}</span>
								</td>
								<td class="mono nowrap">{l.documentNo}<span class="faint">/{l.lineNo}</span></td>
								<td class="nowrap" class:late={l.bucket === 'past_due'}>{day(l.shipDate, year)}</td>
								<td class="num">{count(l.quantity)}</td>
								<td class="num" class:short={l.short > 0}>{#if l.short > 0}{count(l.short)}{:else}<Blank word="nothing short" />{/if}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>

	<section class="panel" aria-labelledby="dod-title">
		<header class="panel-head">
			<h2 id="dod-title">Since the last export</h2>
			<span class="faint">
				{#if board.dayOverDay.previousId}
					Snapshot #{board.current.id} against #{board.dayOverDay.previousId}
				{:else}
					First snapshot: every line is new
				{/if}
			</span>
		</header>
		<dl class="changes">
			<div>
				<dt>New</dt>
				<dd class="num">{count(board.dayOverDay.counts.new)}</dd>
			</div>
			<div>
				<dt>Gone (shipped or cancelled)</dt>
				<dd class="num">{count(board.dayOverDay.counts.shipped)}</dd>
			</div>
			<div>
				<dt>Newly short</dt>
				<dd class="num" class:short={board.dayOverDay.counts.newly_short > 0}>
					{count(board.dayOverDay.counts.newly_short)}
				</dd>
			</div>
		</dl>
		{#if board.dayOverDay.previousId && board.dayOverDay.lines.length > 0}
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th scope="col">Change</th>
							<th scope="col">Customer</th>
							<th scope="col">Item</th>
							<th scope="col">Order</th>
							<th scope="col">Ships</th>
							<th scope="col" class="num">Qty</th>
							<th scope="col" class="num">Short</th>
						</tr>
					</thead>
					<tbody>
						{#each board.dayOverDay.lines as l (l.change + l.documentNo + ':' + l.lineNo)}
							<tr>
								<td><span class="chip" class:warn={l.change === 'newly_short'}>{CHANGE_LABEL[l.change]}</span></td>
								<td class="customer">{l.customerName}</td>
								<td class="mono">{l.itemNo}</td>
								<td class="mono nowrap">{l.documentNo}<span class="faint">/{l.lineNo}</span></td>
								<td class="nowrap">{day(l.shipDate, year)}</td>
								<td class="num">{count(l.quantity)}</td>
								<td class="num">
									{#if l.change === 'newly_short'}
										<span class="short">{count(l.shortNow ?? 0)}</span>
										<span class="faint">was 0</span>
									{:else if l.change === 'new'}
										{#if l.shortNow}{count(l.shortNow)}{:else}<Blank word="nothing short" />{/if}
									{:else}
										·
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>
{/if}

<section class="panel" aria-labelledby="history-title">
	<header class="panel-head">
		<h2 id="history-title">Recent snapshots</h2>
	</header>
	{#if board.history.length === 0}
		<p class="body muted">No files loaded yet.</p>
	{:else}
		<div class="table-wrap">
			<table>
				<thead>
					<tr>
						<th scope="col">Snapshot</th>
						<th scope="col">Report</th>
						<th scope="col">Status</th>
						<th scope="col" class="num">Rows</th>
						<th scope="col">Flags</th>
						<th scope="col">Loaded</th>
						<th scope="col">Decided</th>
					</tr>
				</thead>
				<tbody>
					{#each board.history as h (h.id)}
						<tr>
							<td class="nowrap">
								<a class="link mono" href="/operations?snapshot={h.id}">#{h.id}</a>
								<span class="faint file">{h.fileName}</span>
							</td>
							<td class="nowrap">{EXPORT_KIND_LABEL[h.kind]}</td>
							<td class="nowrap">
								{STATUS_LABEL[h.status]}
								{#if h.isCurrent}<span class="chip live">live</span>{/if}
							</td>
							<td class="num">{count(h.rowCount)}</td>
							<td class="nowrap">
								{#each h.holdCodes as code (code)}<span class="chip warn">{HOLD_LABEL[code]}</span>{/each}
							</td>
							<td class="nowrap">{h.stagedBy} <span class="faint">{moment(h.stagedAt)}</span></td>
							<td>
								{#if h.decidedAt}
									<span class="nowrap">{h.decidedBy} <span class="faint">{moment(h.decidedAt)}</span></span>
									{#if h.decisionNote}<span class="note muted">"{h.decisionNote}"</span>{/if}
								{:else}
									<span class="faint">·</span>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>

<style>
	/* One quiet color per bucket, borrowed from the commitment statuses. */
	section {
		--bucket-past_due: var(--status-broken);
		--bucket-at_risk: var(--status-pushed);
		--bucket-on_pace: var(--status-kept);
		--bucket-later: var(--status-promised);
	}

	.body {
		padding: 10px var(--space-3);
	}

	.small {
		font-size: 0.92rem;
	}

	.figures,
	.changes {
		display: flex;
		flex-wrap: wrap;
		margin: 0;
	}

	.figure {
		flex: 1 1 170px;
		display: grid;
		gap: 2px;
		align-content: start;
		padding: 10px var(--space-3);
	}

	.figure + .figure {
		border-left: 1px solid var(--hairline);
	}

	.figures dt {
		display: flex;
		align-items: center;
		gap: 6px;
		font-weight: 500;
	}

	.figures dd {
		margin: 0;
	}

	.big {
		font-size: 1.35rem;
		font-weight: 600;
		letter-spacing: -0.015em;
	}

	.swatch {
		display: inline-block;
		flex: none;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: color-mix(in srgb, var(--tone) 30%, transparent);
		box-shadow: inset 0 0 0 1.5px var(--tone);
	}

	/* A thin bar: each bucket's share of the open lines. */
	.share {
		display: flex;
		gap: 2px;
		height: 4px;
		margin: 0 var(--space-3);
	}

	.share span {
		flex-basis: 0;
		min-width: 0;
		border-radius: 2px;
		background: var(--tone);
		opacity: 0.75;
	}

	.short {
		color: var(--warning);
	}

	.late {
		color: var(--danger);
	}

	.changes {
		border-bottom: 1px solid var(--hairline);
	}

	.changes div {
		flex: 1 1 140px;
		padding: 10px var(--space-3);
	}

	.changes div + div {
		border-left: 1px solid var(--hairline);
	}

	.changes dt {
		font-size: 0.85rem;
		color: var(--text-muted);
	}

	.changes dd {
		margin: 2px 0 0;
		font-size: 1.2rem;
		font-weight: 600;
		text-align: left;
	}

	.table-wrap {
		overflow-x: auto;
		max-height: 420px;
		overflow-y: auto;
	}

	/* Column headings stay put while the rows scroll. */
	thead th {
		position: sticky;
		top: 0;
		background: var(--surface);
		z-index: 1;
	}

	.nowrap {
		white-space: nowrap;
	}

	.customer {
		min-width: 180px;
	}

	.customer .swatch {
		margin-right: 4px;
	}

	.desc {
		display: block;
		font-size: 0.85rem;
		max-width: 260px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.file {
		margin-left: 4px;
		font-size: 0.85rem;
	}

	.chip + .chip {
		margin-left: 4px;
	}

	.chip.live {
		margin-left: 4px;
		color: var(--status-kept);
	}

	.note {
		display: block;
		font-size: 0.85rem;
	}

	@media (max-width: 720px) {
		.figure {
			flex-basis: 45%;
		}

		.figure + .figure,
		.changes div + div {
			border-left: 0;
		}

		.file {
			display: none;
		}
	}
</style>
