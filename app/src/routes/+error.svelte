<script lang="ts">
	/*
	  What a person sees when a page could not be built. It has to do three
	  things: say what happened in a sentence, say what to try, and give a
	  control that tries it. The old version printed the status and offered
	  one link, always to the commitment board, which is the wrong place to
	  land from an operations URL.
	*/
	import { page } from '$app/state';

	// What happened, in a person's words, per status.
	const HEADLINE: Record<number, string> = {
		400: 'That request did not make sense',
		401: 'You are not signed in',
		403: 'That is not yours to open',
		404: 'Not found',
		409: 'Someone else changed it first',
		429: 'Too many requests for now',
		500: 'Something went wrong',
		503: 'The database did not answer'
	};

	// What to try next, per status.
	const ADVICE: Record<number, string> = {
		400: 'Check the address and try again.',
		401: 'Sign in and come back to this page.',
		403: 'Ask the person who owns this record, or an admin, to open it for you.',
		404: 'The address may be wrong, or the record may have been removed.',
		409: 'Load the page again to see the current version, then make your change.',
		429: 'Wait a minute and try again.',
		500: 'Trying again often works. If it keeps failing, the database is the place to look.',
		503: 'Trying again often works. The database may be busy.'
	};

	const status = $derived(page.status);
	const headline = $derived(HEADLINE[status] ?? 'Something went wrong');
	const advice = $derived(
		ADVICE[status] ?? 'Trying again often works. If it keeps failing, take the address to the log.'
	);

	// The section this URL belongs to, so "back" goes somewhere sensible
	// rather than always to the commitment board.
	const section = $derived.by(() => {
		const first = page.url.pathname.split('/').filter(Boolean)[0];
		const SECTIONS: Record<string, string> = {
			accounts: 'Accounts',
			ask: 'Ask',
			automations: 'Automations',
			commitments: 'Commitments',
			operations: 'Operations',
			parts: 'Parts',
			rfq: 'RFQ intake',
			search: 'Search',
			vendors: 'Vendors',
			warehouse: 'Warehouse'
		};
		return first && SECTIONS[first] ? { href: `/${first}`, label: SECTIONS[first] } : null;
	});

	// A 404 will not fix itself, so it gets no retry control.
	const canRetry = $derived(status !== 404 && status !== 403);
</script>

<svelte:head>
	<title>{headline} · Northline</title>
</svelte:head>

<main id="content" class="page read">
	<div class="box">
		<p class="t-meta mono muted">{status}</p>
		<h1>{headline}</h1>
		<p class="muted prose">{advice}</p>

		{#if page.error?.message && page.error.message !== headline}
			<!-- The server's own sentence, kept as detail rather than as the
			     headline, because it is written for whoever is reading the log. -->
			<p class="detail t-meta muted">{page.error.message}</p>
		{/if}

		<p class="actions">
			{#if canRetry}
				<a class="button primary" href={page.url.pathname + page.url.search} data-sveltekit-reload>
					Try again
				</a>
			{/if}
			{#if section}
				<a class="button" href={section.href}>Back to {section.label}</a>
			{:else}
				<a class="button" href="/commitments">Back to Commitments</a>
			{/if}
		</p>
	</div>
</main>

<style>
	/* The reading width from app.css, pushed down the page a little. */
	.page {
		padding-top: 12vh;
	}

	.box {
		display: grid;
		gap: var(--space-2);
		justify-items: start;
	}

	.detail {
		padding: var(--space-2) var(--space-3);
		border-left: 2px solid var(--hairline-strong);
		background: var(--surface-sunken);
		border-radius: 0 var(--radius) var(--radius) 0;
	}

	.actions {
		display: flex;
		gap: var(--space-2);
		flex-wrap: wrap;
		margin-top: var(--space-3);
	}
</style>
