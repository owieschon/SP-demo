<script lang="ts">
	// One change to a draft (pick a part, fix a quantity, choose a customer
	// ...). It carries the draft's row version and a request id from the
	// server, so a stale page or a double click cannot change anything twice.
	// The server re-validates the whole draft after every change.
	import type { Snippet } from 'svelte';
	import { enhance } from '$app/forms';

	let {
		draftId,
		updatedAt,
		requestId,
		change,
		line = null,
		label,
		children
	}: {
		draftId: number;
		updatedAt: string;
		requestId: string;
		change: string;
		line?: number | null;
		/** For screen readers: what this form changes. */
		label: string;
		children: Snippet<[{ saving: boolean }]>;
	} = $props();

	let saving = $state(false);
</script>

<form
	method="POST"
	action="?/revise"
	class="change"
	aria-label={label}
	aria-busy={saving}
	use:enhance={() => {
		saving = true;
		return async ({ update }) => {
			await update({ reset: false });
			saving = false;
		};
	}}
>
	<input type="hidden" name="draftId" value={draftId} />
	<input type="hidden" name="expectedUpdatedAt" value={updatedAt} />
	<input type="hidden" name="requestId" value={requestId} />
	<input type="hidden" name="change" value={change} />
	{#if line !== null}<input type="hidden" name="line" value={line} />{/if}
	{@render children({ saving })}
</form>

<style>
	.change {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		margin: 0;
	}

	.change[aria-busy='true'] {
		opacity: 0.6;
		pointer-events: none;
	}
</style>
