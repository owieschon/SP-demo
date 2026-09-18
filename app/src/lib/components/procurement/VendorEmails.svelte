<script lang="ts">
	// The vendor emails waiting for a person.
	//
	// Nothing here has been sent, and this app has no way to send it. Each one
	// was written from the approved order and checked against the disclosure
	// policy before it was stored: a vendor is told the parts, the quantities,
	// the dates, the prices we pay it and our terms with it, and never a
	// customer's name, our selling prices, our margins or another vendor's
	// prices.
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import { moment } from '$lib/format';
	import type { ProcurementSources, VendorEmailDraft } from './types';

	let {
		drafts,
		sources
	}: {
		drafts: VendorEmailDraft[];
		sources: ProcurementSources;
	} = $props();

	let opened = $state<number | null>(null);
	$effect(() => {
		// The newest one starts open: it is almost always the one just made.
		opened = drafts.length > 0 ? drafts[0].id : null;
	});
</script>

<section class="panel" aria-labelledby="emails-title">
	<header class="panel-head">
		<h2 id="emails-title">Vendor emails</h2>
		<span class="faint">
			{#if sources.mailDrafts}
				Mirrored into the mail review queue
			{:else}
				Held here for a person
			{/if}
		</span>
	</header>

	{#if drafts.length === 0}
		<p class="body muted">
			Nothing waiting. Approving a suggested order writes the vendor an email and leaves it here.
		</p>
	{:else}
		<p class="body faint small">
			Nothing here has been sent, and this app cannot send it. Read it, change anything you want, then
			send it yourself.
		</p>

		{#each drafts as draft (draft.id)}
			{@const open = opened === draft.id}
			<div class="draft">
				<h3>
					<button
						class="head pressable"
						type="button"
						aria-expanded={open}
						aria-controls="email-{draft.id}"
						onclick={() => (opened = open ? null : draft.id)}
					>
						<ChevronRight size={14} strokeWidth={2} class="caret" aria-hidden="true" />
						<span class="who">
							<span class="subject">{draft.subject}</span>
							<span class="faint to">
								to {draft.toName ? `${draft.toName}, ` : ''}{draft.toEmail}
							</span>
						</span>
						<span class="meta faint">
							{#if draft.mailDraftId !== null}
								<span class="chip">in the mail queue</span>
							{/if}
							{draft.queuedBy}
							{moment(draft.queuedAt)}
						</span>
					</button>
				</h3>

				{#if open}
					<div class="letter" id="email-{draft.id}">
						<dl class="head-fields">
							<div><dt>To</dt><dd>{draft.toName ? `${draft.toName} <` : ''}{draft.toEmail}{draft.toName ? '>' : ''}</dd></div>
							<div><dt>Subject</dt><dd>{draft.subject}</dd></div>
						</dl>
						<!-- Plain text, shown as written: a purchase order gets forwarded,
						     printed and pasted into an ERP, and plain text survives all three. -->
						<pre>{draft.body}</pre>
					</div>
				{/if}
			</div>
		{/each}
	{/if}
</section>

<style>
	.body {
		padding: 10px var(--space-3);
	}

	.small {
		font-size: 0.92rem;
	}

	.draft {
		border-top: 1px solid var(--hairline);
	}

	.draft h3 {
		margin: 0;
	}

	.head {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		width: 100%;
		padding: 8px var(--space-3);
		border: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
		-webkit-tap-highlight-color: transparent;
		transition:
			background-color var(--speed) var(--ease),
			transform var(--speed) var(--ease);
	}

	.head:hover {
		background: var(--surface-hover);
	}

	.head :global(.caret) {
		flex: none;
		color: var(--text-faint);
		transition: transform var(--speed-slow) var(--ease);
	}

	.head[aria-expanded='true'] :global(.caret) {
		transform: rotate(90deg);
	}

	.who {
		display: grid;
		min-width: 0;
		line-height: 1.3;
	}

	.subject {
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.to {
		font-size: 0.85rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.meta {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 6px;
		flex: none;
		font-size: 0.85rem;
		white-space: nowrap;
	}

	.letter {
		padding: 0 var(--space-3) var(--space-3) 34px;
	}

	.head-fields {
		display: grid;
		gap: 2px;
		margin: 0 0 var(--space-2);
		font-size: 0.92rem;
	}

	.head-fields div {
		display: flex;
		gap: 6px;
	}

	.head-fields dt {
		width: 56px;
		flex: none;
		color: var(--text-muted);
	}

	.head-fields dd {
		margin: 0;
		min-width: 0;
		overflow-wrap: anywhere;
	}

	pre {
		margin: 0;
		padding: var(--space-3);
		border: 1px solid var(--hairline);
		border-radius: var(--radius);
		background: var(--surface-sunken);
		font-family: var(--font-mono);
		font-size: 0.85rem;
		line-height: 1.5;
		/* The table inside the letter is aligned with spaces, so it must not
		   be rewrapped; it scrolls sideways instead. */
		overflow-x: auto;
		white-space: pre;
	}

	@media (max-width: 720px) {
		.meta {
			display: none;
		}

		.letter {
			padding-left: var(--space-3);
		}
	}
</style>
