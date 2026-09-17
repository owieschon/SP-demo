<script lang="ts">
	// One conversation: the thread, and the box to carry on asking.
	import AskBox from '$lib/components/assistant/AskBox.svelte';
	import Conversation from '$lib/components/assistant/Conversation.svelte';
	import ConversationSkeleton from '$lib/components/assistant/ConversationSkeleton.svelte';
	import ModeBadge from '$lib/components/assistant/ModeBadge.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let question = $state('');

	const message = $derived(form && 'message' in form ? form.message : null);
	const capped = $derived(Boolean(form && 'capped' in form && form.capped));
	const done = $derived(form && 'decided' in form && form.decided ? form.message : null);
	const liveMessage = $derived(form && 'liveMessage' in form ? form.liveMessage : null);
	const liveOk = $derived(!form || !('liveOk' in form) || form.liveOk !== false);
</script>

<svelte:head>
	<title>Ask Northline</title>
</svelte:head>

<main class="page">
	{#await data.conversation}
		<header class="head">
			<span class="skeleton" style:width="320px" style:height="18px"></span>
		</header>
		<ConversationSkeleton />
	{:then conversation}
		{#if !conversation}
			<section class="panel empty">
				<p>That conversation does not exist, or it is not yours.</p>
				<a class="button" href="/ask">Start a new one</a>
			</section>
		{:else}
			<header class="head">
				<h1>{conversation.title}</h1>
				<p class="faint small">
					{conversation.messageCount} of {data.caps.conversationMessages} messages ·
					{conversation.messagesLeft <= 2
						? 'this conversation is full, start a new one'
						: `${Math.floor(conversation.messagesLeft / 2)} more questions fit here`}
				</p>
			</header>

			<Conversation {conversation} requestId={data.requestId} />

			{#if done}
				<p class="notice" role="status">{done}</p>
			{/if}

			<section class="panel ask" aria-labelledby="more-title">
				<header class="panel-head">
					<h2 id="more-title">Ask something else</h2>
					<ModeBadge mode={data.mode} {liveMessage} {liveOk} />
				</header>
				<AskBox
					requestId={data.requestId}
					caps={data.caps}
					conversationId={conversation.id}
					bind:question
					placeholder="Carry on: it can see this conversation, including what you approved."
				/>
				{#if message}
					<p class="body notice" class:error={!capped} class:warning={capped} role="alert">{message}</p>
				{/if}
			</section>
		{/if}
	{:catch}
		<p class="notice error" role="alert">This conversation could not be loaded. Reload the page to try again.</p>
	{/await}
</main>

<style>
	.page {
		max-width: 860px;
		margin: 0 auto;
		padding: var(--space-5) var(--space-4) var(--space-6);
		display: grid;
		gap: var(--space-4);
	}

	.head {
		display: grid;
		gap: 4px;
	}

	.head h1 {
		font-size: 1.15rem;
	}

	.small {
		font-size: 0.88rem;
	}

	.panel-head {
		flex-wrap: wrap;
	}

	.body {
		padding: var(--space-3);
	}

	.empty {
		display: grid;
		justify-items: start;
		gap: var(--space-3);
		padding: var(--space-4);
	}

	.ask {
		position: sticky;
		bottom: var(--space-3);
		background: var(--surface);
		box-shadow: var(--overlay-shadow);
	}

	@media (max-width: 720px) {
		.page {
			padding: var(--space-3);
		}

		.ask {
			position: static;
			box-shadow: none;
		}
	}
</style>
