<script lang="ts">
	// Ask Northline: the question box, a few questions that work, and the
	// conversations you have had.
	import MessagesSquare from '@lucide/svelte/icons/messages-square';
	import AskBox from '$lib/components/assistant/AskBox.svelte';
	import ModeBadge from '$lib/components/assistant/ModeBadge.svelte';
	import DraftListSkeleton from '$lib/components/rfq/DraftListSkeleton.svelte';
	import { STARTERS } from '$lib/assistant/types';
	import { moment } from '$lib/format';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let question = $state('');

	const message = $derived(form && 'message' in form ? form.message : null);
	const capped = $derived(Boolean(form && 'capped' in form && form.capped));
	const liveMessage = $derived(form && 'liveMessage' in form ? form.liveMessage : null);
	const liveOk = $derived(!form || !('liveOk' in form) || form.liveOk !== false);
</script>

<svelte:head>
	<title>Ask Northline</title>
</svelte:head>

<main class="page">
	<header class="head">
		<h1>Ask Northline</h1>
		<p class="faint">
			Ask about the book and it answers from the database, showing every lookup it made. It can add a note or a
			next step on its own. Anything that changes a record it can only propose, and you approve it.
		</p>
	</header>

	<section class="panel" aria-labelledby="ask-title">
		<header class="panel-head">
			<h2 id="ask-title">Your question</h2>
			<ModeBadge mode={data.mode} {liveMessage} {liveOk} />
		</header>

		<AskBox requestId={data.requestId} caps={data.caps} bind:question />

		{#if message}
			<p class="body notice" class:error={!capped} class:warning={capped} role="alert">{message}</p>
		{/if}
	</section>

	<section class="panel" aria-labelledby="starters-title">
		<header class="panel-head">
			<h2 id="starters-title">Try one of these</h2>
			<span class="faint small">All four work with or without a model key</span>
		</header>
		<ul class="starters">
			{#each STARTERS as starter (starter.question)}
				<li>
					<button type="button" class="starter pressable" onclick={() => (question = starter.question)}>
						<span class="q">{starter.question}</span>
						<span class="faint small">{starter.why}</span>
					</button>
				</li>
			{/each}
		</ul>
	</section>

	<section class="panel" aria-labelledby="recent-title">
		<header class="panel-head">
			<h2 id="recent-title">Your conversations</h2>
		</header>
		{#await data.conversations}
			<DraftListSkeleton />
		{:then conversations}
			{#if conversations.length === 0}
				<p class="body muted">Nothing yet. Ask a question above, or pick one of the four.</p>
			{:else}
				<ul class="recent">
					{#each conversations as item (item.id)}
						<li>
							<a href="/ask/{item.id}" class="row">
								<MessagesSquare size={14} aria-hidden="true" />
								<span class="what">
									<span class="title">{item.title}</span>
									<span class="faint small">
										{item.messageCount} {item.messageCount === 1 ? 'message' : 'messages'} ·
										{item.mode === 'mock' ? 'scripted' : item.mode === 'mcp' ? 'via MCP' : 'live'}
									</span>
								</span>
								{#if item.openProposals > 0}
									<span class="chip warn">
										{item.openProposals} to decide
									</span>
								{/if}
								<span class="faint small when">{moment(item.updatedAt)}</span>
							</a>
						</li>
					{/each}
				</ul>
			{/if}
		{:catch}
			<p class="body notice error" role="alert">
				Your conversations could not be loaded. Reload the page to try again.
			</p>
		{/await}
	</section>
</main>

<style>
	.page {
		max-width: 860px;
		margin: 0 auto;
		padding: var(--space-5) var(--space-4) var(--space-6);
		display: grid;
		gap: var(--space-3);
	}

	.head {
		display: grid;
		gap: 4px;
	}

	.head p {
		max-width: 76ch;
	}

	.panel-head {
		flex-wrap: wrap;
	}

	.body {
		padding: var(--space-3);
	}

	.small {
		font-size: 0.88rem;
	}

	.starters {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.starters li + li {
		border-top: 1px solid var(--hairline);
	}

	.starter {
		display: grid;
		gap: 2px;
		width: 100%;
		padding: 8px var(--space-3);
		border: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
		transition: background-color var(--speed) var(--ease);
	}

	.starter:hover {
		background: var(--surface-hover);
	}

	.starter .q {
		font-weight: 500;
	}

	.recent {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.recent li + li {
		border-top: 1px solid var(--hairline);
	}

	.row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		min-height: 42px;
		padding: 6px var(--space-3);
		transition:
			background-color var(--speed) var(--ease),
			transform var(--speed) var(--ease);
	}

	.row:hover {
		background: var(--surface-hover);
	}

	.row:active {
		background: var(--surface-press);
	}

	.row :global(svg) {
		flex: none;
		color: var(--text-faint);
	}

	.what {
		flex: 1;
		min-width: 0;
		display: grid;
	}

	.what > span {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.what .title {
		font-weight: 500;
	}

	.when {
		flex: none;
		white-space: nowrap;
	}

	@media (max-width: 720px) {
		.page {
			padding: var(--space-3);
		}

		.when {
			display: none;
		}
	}
</style>
