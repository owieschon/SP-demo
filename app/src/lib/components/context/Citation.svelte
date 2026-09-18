<script lang="ts">
	/*
	  One citation: the source, when it was said, and the words themselves.

	  This component is the trust claim of the whole feature. A fact with no
	  visible snippet is an assertion; a fact with the sentence it was read out
	  of, its locator and its source's trust tier beside it is something a
	  person can argue with. So the snippet is always shown, never behind a
	  disclosure, and the link into the real record is the extra rather than
	  the point.
	*/
	import { sourceLink, trustLabel } from '$lib/context/links';
	import { day } from '$lib/format';
	import type { Citation } from '$lib/context/types';

	let {
		citation,
		/** The year the page is showing, so a date in it loses its year. */
		thisYear
	}: { citation: Citation; thisYear?: number } = $props();

	const link = $derived(sourceLink(citation));
</script>

<figure class="cite">
	<blockquote>{citation.snippet}</blockquote>
	<figcaption class="t-meta muted">
		{citation.source_name}
		<span aria-hidden="true">·</span>
		<span title="Trust tier {citation.trust_tier} of 5">{trustLabel(citation.trust_tier)}</span>
		<span aria-hidden="true">·</span>
		{citation.locator}
		<span aria-hidden="true">·</span>
		said {day(citation.asserted_at, thisYear)}
		<span aria-hidden="true">·</span>
		read by {citation.extractor} v{citation.extractor_version}
		{#if link.href}
			<span aria-hidden="true">·</span>
			<a class="link" href={link.href}>{link.label}</a>
		{:else if citation.document_title}
			<span aria-hidden="true">·</span>
			<span>{citation.document_title}</span>
		{/if}
	</figcaption>
</figure>

<style>
	.cite {
		margin: 0;
		display: grid;
		gap: 2px;
	}

	blockquote {
		margin: 0;
		padding-left: var(--space-3);
		border-left: 2px solid var(--hairline);
		font-size: var(--fs-body);
	}

	figcaption {
		padding-left: var(--space-3);
		/* The provenance line wraps rather than pushing the panel wide, which
		   matters most at phone width where it is four or five items long. */
		display: flex;
		flex-wrap: wrap;
		gap: 0 6px;
	}
</style>
