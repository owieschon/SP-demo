<script lang="ts">
	// The files a request arrived as: what each one is, what was read out of
	// it, and a link to download the file itself.
	//
	// The download link points at the app's own route, which serves the bytes
	// with the media type that was stored, not the one the browser claimed,
	// and always as an attachment. Nothing here ever renders a file's
	// contents.
	import FileSpreadsheet from '@lucide/svelte/icons/file-spreadsheet';
	import FileText from '@lucide/svelte/icons/file-text';
	import FileType from '@lucide/svelte/icons/file-type';
	import Download from '@lucide/svelte/icons/download';
	import type { AttachmentSummary } from '$lib/server/documents/store';

	let { attachments, draftId }: { attachments: AttachmentSummary[]; draftId: number } = $props();

	const LABELS: Record<AttachmentSummary['kind'], string> = {
		txt: 'Text',
		eml: 'Email',
		pdf: 'PDF',
		xlsx: 'Spreadsheet',
		xls: 'Spreadsheet',
		csv: 'CSV'
	};

	/** Sizes people read: 812 bytes, 19.5 KB, 2.1 MB. */
	function size(bytes: number): string {
		if (bytes < 1024) return `${bytes} bytes`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}
</script>

<ul class="files">
	{#each attachments as file (file.id)}
		<li>
			<span class="icon" aria-hidden="true">
				{#if file.kind === 'pdf'}
					<FileType size={15} />
				{:else if file.kind === 'xlsx' || file.kind === 'xls' || file.kind === 'csv'}
					<FileSpreadsheet size={15} />
				{:else}
					<FileText size={15} />
				{/if}
			</span>
			<span class="what">
				<span class="name">{file.fileName}</span>
				<span class="faint small">
					{LABELS[file.kind]} · {size(file.byteSize)} · {file.summary}
					{#if file.pageCount !== null}· {file.pageCount} {file.pageCount === 1 ? 'page' : 'pages'}{/if}
				</span>
			</span>
			<a class="button quiet" href="/rfq/{draftId}/attachments/{file.id}" download={file.fileName}>
				<Download size={13} aria-hidden="true" />
				Download
			</a>
		</li>
	{/each}
</ul>

<style>
	.files {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.files li {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		min-height: 44px;
		padding: 6px var(--space-3);
	}

	.files li + li {
		border-top: 1px solid var(--hairline);
	}

	.icon {
		flex: none;
		display: inline-flex;
		color: var(--text-muted);
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

	.name {
		font-weight: 500;
	}

	.small {
		font-size: 0.85rem;
	}

	.files a {
		flex: none;
	}

	@media (max-width: 560px) {
		.files li {
			flex-wrap: wrap;
		}
	}
</style>
