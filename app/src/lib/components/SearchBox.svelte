<script lang="ts">
	// The top bar's search box: accounts, parts and vendors in one field.
	//
	// It is a plain form with method="GET", so pressing Enter goes to
	// /search?q=... whether or not JavaScript is running. SvelteKit treats a
	// GET form like a link and navigates without a full page load.
	//
	// Pressing "/" anywhere on the page puts the cursor in here, the way it
	// works in the tools this app sits beside.
	import Search from '@lucide/svelte/icons/search';
	import { page } from '$app/state';

	let { placeholder = 'Search' }: { placeholder?: string } = $props();

	let input: HTMLInputElement | null = $state(null);

	// On the search page itself the box shows what was searched for.
	const value = $derived(page.url.pathname === '/search' ? (page.url.searchParams.get('q') ?? '') : '');

	function focusOnSlash(event: KeyboardEvent) {
		if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
		// Not while someone is typing in a field.
		const target = event.target as HTMLElement | null;
		const tag = target?.tagName;
		if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;
		event.preventDefault();
		input?.focus();
		input?.select();
	}
</script>

<svelte:window onkeydown={focusOnSlash} />

<form class="search" method="GET" action="/search" role="search">
	<Search size={14} strokeWidth={1.75} aria-hidden="true" />
	<input
		bind:this={input}
		type="search"
		name="q"
		{placeholder}
		{value}
		autocomplete="off"
		spellcheck="false"
		aria-label="Search accounts, parts and vendors"
		aria-keyshortcuts="/"
	/>
	<!-- Visible only until the field has focus: what the shortcut is. -->
	<kbd aria-hidden="true">/</kbd>
</form>

<style>
	.search {
		display: flex;
		align-items: center;
		gap: 6px;
		height: var(--control-h);
		padding: 0 8px;
		border: 1px solid var(--hairline-strong);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text-muted);
		transition:
			border-color var(--speed) var(--ease),
			box-shadow var(--speed) var(--ease),
			color var(--speed) var(--ease);
	}

	.search:focus-within {
		border-color: var(--focus);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--focus) 22%, transparent);
		color: var(--text);
	}

	.search :global(svg) {
		flex: none;
	}

	input {
		width: 150px;
		height: 100%;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--text);
		transition: width var(--speed-slow) var(--ease);
	}

	input:hover,
	input:focus-visible {
		border: 0;
		box-shadow: none;
		outline: none;
	}

	input:focus {
		width: 240px;
	}

	/* Chrome draws its own clear button on a search field; the box has its own look. */
	input::-webkit-search-cancel-button {
		-webkit-appearance: none;
		appearance: none;
	}

	kbd {
		flex: none;
		font-family: var(--font-mono);
		font-size: 0.78rem;
		line-height: 1;
		padding: 2px 5px;
		border-radius: var(--radius-sm);
		color: var(--text-faint);
		background: var(--surface-sunken);
		box-shadow: inset 0 0 0 1px var(--hairline);
	}

	.search:focus-within kbd {
		visibility: hidden;
	}

	@media (max-width: 720px) {
		input,
		input:focus {
			width: 130px;
		}

		kbd {
			display: none;
		}
	}
</style>
