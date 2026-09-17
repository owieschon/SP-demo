<script lang="ts">
	// The two ways a quote leaves the building: as a PDF, and as an email in
	// the person's own mail app.
	//
	// The honest part: a mailto: link cannot carry a file. No browser lets a
	// link attach anything. So this says so, in those words, and puts the
	// download first, because the order of the buttons is the order of the
	// work: get the PDF, open the email, attach the PDF, send.
	import FileDown from '@lucide/svelte/icons/file-down';
	import Mail from '@lucide/svelte/icons/mail';
	import { moneyExact } from '$lib/format';
	import type { MailDraft } from '$lib/server/documents/mailto';

	let {
		pdfUrl,
		mail,
		lineCount,
		subtotal,
		/** What the PDF is called, so the browser saves it under that name. */
		fileName
	}: {
		pdfUrl: string;
		mail: MailDraft;
		lineCount: number;
		subtotal: number;
		fileName: string;
	} = $props();
</script>

<div class="actions">
	<a class="button primary" href={pdfUrl} download={fileName}>
		<FileDown size={14} aria-hidden="true" />
		Download PDF
	</a>

	{#if mail.to}
		<a class="button" href={mail.href}>
			<Mail size={14} aria-hidden="true" />
			Open in your mail app
		</a>
	{:else}
		<span class="faint small">
			No buyer is named on this quote, so there is no address to write to. Name the buyer on the account and the
			email will be ready here.
		</span>
	{/if}
</div>

<p class="faint small">
	The PDF holds {lineCount} {lineCount === 1 ? 'line' : 'lines'} totalling {moneyExact(subtotal)}. A link cannot
	attach a file to an email, so nothing is attached for you: download the PDF first, then attach it to the message
	that opens.
</p>

{#if mail.to}
	<details class="preview">
		<summary>What the email will say</summary>
		<dl>
			<dt>To</dt>
			<dd class="mono">{mail.to}</dd>
			<dt>Subject</dt>
			<dd>{mail.subject}</dd>
		</dl>
		<pre>{mail.body}</pre>
	</details>
{/if}

<style>
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}

	.small {
		font-size: 0.88rem;
	}

	p {
		margin: 8px 0 0;
		max-width: 68ch;
	}

	.preview {
		margin-top: var(--space-2);
	}

	.preview summary {
		cursor: pointer;
		font-size: 0.88rem;
		color: var(--text-muted);
		padding: 4px 0;
	}

	.preview summary:hover {
		color: var(--text);
	}

	.preview dl {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 2px var(--space-3);
		margin: 4px 0;
		font-size: 0.88rem;
	}

	.preview dt {
		color: var(--text-muted);
	}

	.preview dd {
		margin: 0;
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.preview pre {
		margin: 0;
		padding: var(--space-2);
		border: 1px solid var(--hairline);
		border-radius: var(--radius);
		background: var(--surface-sunken);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		font-size: 0.82rem;
		max-height: 280px;
		overflow: auto;
	}
</style>
