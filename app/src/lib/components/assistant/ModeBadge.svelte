<script lang="ts">
	// Which model is answering, and the way in to the real one.
	//
	// The badge never says Claude unless Claude is really answering: scripted
	// demo mode is labelled as scripted, every time, including for visitors who
	// will only ever see that mode.
	import { enhance } from '$app/forms';
	import Lock from '@lucide/svelte/icons/lock';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import Cpu from '@lucide/svelte/icons/cpu';
	import type { ModeView } from '$lib/assistant/types';

	let {
		mode,
		liveMessage = null,
		liveOk = true
	}: { mode: ModeView; liveMessage?: string | null; liveOk?: boolean } = $props();

	let unlocking = $state(false);
</script>

<div class="mode">
	<span class="chip" class:live={mode.unlocked}>
		{#if mode.unlocked}
			<Sparkles size={12} aria-hidden="true" />Live: {mode.model}
		{:else}
			<Cpu size={12} aria-hidden="true" />Scripted answers
		{/if}
	</span>

	{#if !mode.configured}
		<span class="faint small">
			This server has no model key, so a scripted model answers. It runs the same tools, the same gate and the
			same approval as the real one. Add a key in Settings to use the real model.
		</span>
	{:else if mode.unlocked}
		<form method="POST" action="?/lock" use:enhance class="inline">
			<span class="small muted">Each question you ask now costs API credit.</span>
			<button class="button quiet">Turn off</button>
		</form>
	{:else}
		<form
			method="POST"
			action="?/unlock"
			class="inline"
			use:enhance={() => {
				unlocking = true;
				return async ({ update }) => {
					await update();
					unlocking = false;
				};
			}}
		>
			<Lock size={13} aria-hidden="true" />
			<label class="inline-label" for="ask-passphrase">Live mode passphrase</label>
			<input id="ask-passphrase" name="passphrase" type="password" autocomplete="off" required />
			<button class="button" disabled={unlocking} aria-busy={unlocking}>Unlock for an hour</button>
		</form>
	{/if}

	{#if liveMessage}
		<p class="small" class:error-text={!liveOk} role="status">{liveMessage}</p>
	{/if}
</div>

<style>
	.mode {
		display: grid;
		gap: 6px;
		align-items: center;
	}

	.inline {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		margin: 0;
		color: var(--text-muted);
	}

	.inline-label {
		display: inline;
	}

	.inline input {
		height: var(--control-h);
		width: 190px;
	}

	.small {
		font-size: 0.88rem;
	}

	.chip.live {
		color: var(--text);
	}

	.error-text {
		color: var(--danger);
	}
</style>
