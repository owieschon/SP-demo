<script lang="ts">
	// Light / dark / system. Changes the page at once, then tells the server
	// (which keeps the choice in a cookie). Without JavaScript the three
	// buttons still work as a normal form post.
	import Monitor from '@lucide/svelte/icons/monitor';
	import Moon from '@lucide/svelte/icons/moon';
	import Sun from '@lucide/svelte/icons/sun';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { readTheme, type Theme } from './theme';

	// The server already wrote the saved choice onto <html>; start from "system"
	// and read the real value once the page is in the browser.
	let theme = $state<Theme>('system');

	onMount(() => {
		theme = readTheme(document.documentElement.dataset.theme);
	});

	const OPTIONS = [
		{ value: 'light', label: 'Light theme', icon: Sun },
		{ value: 'dark', label: 'Dark theme', icon: Moon },
		{ value: 'system', label: 'Match the system', icon: Monitor }
	] as const;

	let fadeTimer: ReturnType<typeof setTimeout> | undefined;

	function choose(event: SubmitEvent) {
		event.preventDefault();
		const button = event.submitter as HTMLButtonElement | null;
		const next = readTheme(button?.value);
		if (next === theme) return;

		// Ease the colors for a moment (app.css, .theme-changing), then switch.
		const root = document.documentElement;
		root.classList.add('theme-changing');
		root.dataset.theme = next;
		theme = next;
		clearTimeout(fadeTimer);
		fadeTimer = setTimeout(() => root.classList.remove('theme-changing'), 260);

		const body = new FormData();
		body.set('theme', next);
		fetch('/theme', { method: 'POST', body, headers: { accept: 'application/json' } }).catch(() => {
			// The page has already changed; if saving failed, the old theme comes
			// back on the next full page load. Nothing else to do.
		});
	}
</script>

<form method="POST" action="/theme" class="segmented" aria-label="Color theme" onsubmit={choose}>
	<input type="hidden" name="next" value={page.url.pathname + page.url.search} />
	{#each OPTIONS as option (option.value)}
		<button
			name="theme"
			value={option.value}
			aria-pressed={theme === option.value}
			aria-label={option.label}
			title={option.label}
		>
			<option.icon size={13} strokeWidth={1.75} aria-hidden="true" />
		</button>
	{/each}
</form>

<style>
	form button {
		padding: 0 6px;
	}
</style>
