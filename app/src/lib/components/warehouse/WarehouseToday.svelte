<script lang="ts">
	// Today's state in six figures. Each one counts documents (shipments,
	// transfers or count sheets), the lines on them, the pieces and the
	// inventory value at cost.
	import { count, money } from '$lib/format';
	import { BUCKET_HINT, BUCKET_LABEL, type BucketTotal } from './types';

	let { buckets }: { buckets: BucketTotal[] } = $props();

	const totalPieces = $derived(buckets.reduce((sum, b) => sum + b.quantity, 0));
	const totalValue = $derived(buckets.reduce((sum, b) => sum + b.value, 0));
	// The thin bar underneath: each bucket's share of the pieces in play.
	const shares = $derived(
		buckets.map((b) => ({ bucket: b.bucket, share: totalPieces ? b.quantity / totalPieces : 0 }))
	);
</script>

<section class="panel" aria-labelledby="today-title">
	<header class="panel-head">
		<h2 id="today-title">On the floor today</h2>
		<span class="faint">
			<span class="num">{count(totalPieces)}</span> pieces in play ·
			<span class="num">{money(totalValue)}</span> at cost
		</span>
	</header>

	<dl class="figures">
		{#each buckets as b (b.bucket)}
			<div class="figure" style:--tone="var(--wh-{b.bucket})">
				<dt><span class="swatch" aria-hidden="true"></span>{BUCKET_LABEL[b.bucket]}</dt>
				<dd>
					<span class="big num">{count(b.documents)}</span>
					<span class="muted small">{b.bucket === 'counts_due' ? 'sheets' : 'jobs'}</span>
				</dd>
				<dd class="small">
					<span class="num">{count(b.quantity)}</span> pcs ·
					<span class="num">{money(b.value)}</span>
				</dd>
				<dd class="faint small">{BUCKET_HINT[b.bucket]}</dd>
			</div>
		{/each}
	</dl>

	<div class="share" aria-hidden="true">
		{#each shares as s (s.bucket)}
			<span style:--tone="var(--wh-{s.bucket})" style:flex-grow={String(s.share)}></span>
		{/each}
	</div>
</section>

<style>
	/* One quiet color per bucket, borrowed from the commitment statuses. */
	section {
		--wh-to_pick: var(--status-promised);
		--wh-packed: var(--status-quoted);
		--wh-awaiting_carrier: var(--status-pushed);
		--wh-shipped_today: var(--status-kept);
		--wh-in_transit: var(--status-delivering);
		--wh-counts_due: var(--status-broken);
	}

	.figures {
		display: flex;
		flex-wrap: wrap;
		margin: 0;
	}

	.figure {
		flex: 1 1 150px;
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

	.small {
		font-size: 0.92rem;
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

	.share {
		display: flex;
		gap: 2px;
		height: 4px;
		margin: 0 var(--space-3) 10px;
	}

	.share span {
		flex-basis: 0;
		min-width: 0;
		border-radius: 2px;
		background: var(--tone);
		opacity: 0.75;
	}

	@media (max-width: 720px) {
		.figure {
			flex-basis: 45%;
		}

		.figure + .figure {
			border-left: 0;
		}
	}
</style>
