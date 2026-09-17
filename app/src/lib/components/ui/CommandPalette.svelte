<script lang="ts">
	/*
	  Ctrl+K (Cmd+K on a Mac): one box that reaches every screen, the things
	  a person can do, and any account, part or vendor.

	  It matters more here than in most apps. If the point of this product is
	  that a person supervises rather than types, then the things they do are
	  verbs ("approve the drafts the order desk wrote", "change what the desk
	  may send") and a box that only finds nouns would miss the job. So the
	  actions are listed first, and they are real: each one goes to the
	  control that performs it. Nothing in here writes to the database behind
	  a single keystroke.

	  Screens and actions are in the bundle and match instantly. Records come
	  from /api/palette as the person types, two characters in, and arrive
	  under the static matches rather than replacing them.

	  It is a native modal <dialog> (see Drawer), so focus is trapped, Escape
	  closes it and focus goes back to where it was, all from the platform.
	*/
	import { tick } from 'svelte';
	import { goto } from '$app/navigation';
	import CornerDownLeft from '@lucide/svelte/icons/corner-down-left';
	import Search from '@lucide/svelte/icons/search';
	import Drawer from './Drawer.svelte';
	import {
		KIND_LABEL,
		STATIC_ENTRIES,
		groupEntries,
		matchEntries,
		type PaletteEntry
	} from './palette';
	import { moveHighlight } from './dialog';

	let open = $state(false);
	let query = $state('');
	let highlight = $state(0);
	let records = $state<PaletteEntry[]>([]);
	let input: HTMLInputElement | null = $state(null);
	/** Which request the rows on screen came from, so a slow one cannot win. */
	let asked = 0;

	const staticMatches = $derived(matchEntries(query, STATIC_ENTRIES, 10));
	const recordMatches = $derived(matchEntries(query, records, 12));
	const shown = $derived([...staticMatches, ...recordMatches]);
	const groups = $derived(groupEntries(shown));

	/*
	  Ctrl+K and Cmd+K. The global search box in the top bar already owns "/",
	  so this takes the shortcut every other application of this kind uses and
	  leaves that one alone.
	*/
	function onkeydown(event: KeyboardEvent) {
		if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
			event.preventDefault();
			void show();
		}
	}

	async function show() {
		open = true;
		query = '';
		records = [];
		highlight = 0;
		await tick();
		input?.focus();
	}

	async function lookUp(text: string) {
		const mine = ++asked;
		if (text.trim().length < 2) {
			records = [];
			return;
		}
		try {
			const response = await fetch(`/api/palette?q=${encodeURIComponent(text)}`);
			if (!response.ok) return;
			const body = (await response.json()) as { entries: PaletteEntry[] };
			// An earlier request that answered late must not replace newer rows.
			if (mine === asked) records = body.entries;
		} catch {
			// Offline or refused: the screens and actions still work.
		}
	}

	function typed(event: Event) {
		query = (event.currentTarget as HTMLInputElement).value;
		highlight = 0;
		void lookUp(query);
	}

	async function choose(entry: PaletteEntry | undefined) {
		if (!entry) return;
		open = false;
		await goto(entry.href);
	}

	function listKeys(event: KeyboardEvent) {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			highlight = moveHighlight(highlight, shown.length, 1);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			highlight = moveHighlight(highlight, shown.length, -1);
		} else if (event.key === 'Enter') {
			event.preventDefault();
			void choose(shown[highlight]);
		}
	}

	/** Where an entry sits in the flat list, which is what the arrows move through. */
	function indexOf(entry: PaletteEntry): number {
		return shown.indexOf(entry);
	}
</script>

<svelte:window {onkeydown} />

<!--
	The visible way in, for anyone who does not know the shortcut. A palette
	only a keyboard can reach is a palette most people never find.
-->
<button type="button" class="opener" onclick={show}>
	<Search size={14} strokeWidth={1.75} aria-hidden="true" />
	<span class="opener-label">Search or jump to</span>
	<kbd>Ctrl K</kbd>
</button>

<Drawer bind:open title="Search or jump to" placement="center" bare>
	<div class="palette">
		<div class="box">
			<Search size={15} strokeWidth={1.75} aria-hidden="true" />
			<input
				bind:this={input}
				type="text"
				role="combobox"
				aria-expanded="true"
				aria-controls="palette-list"
				aria-activedescendant={shown[highlight] ? `palette-${shown[highlight].id}` : undefined}
				aria-label="Search screens, actions and records"
				placeholder="Type what you want to do, or a name or number"
				value={query}
				oninput={typed}
				onkeydown={listKeys}
				autocomplete="off"
				spellcheck="false"
			/>
		</div>

		<div class="list" id="palette-list" role="listbox" aria-label="Matches">
			{#each groups as group (group.kind)}
				<p class="group" role="presentation">{KIND_LABEL[group.kind]}</p>
				{#each group.entries as entry (entry.id)}
					<a
						id="palette-{entry.id}"
						role="option"
						aria-selected={indexOf(entry) === highlight}
						class="row"
						class:on={indexOf(entry) === highlight}
						href={entry.href}
						onmouseenter={() => (highlight = indexOf(entry))}
						onclick={(event) => {
							// Let a middle click or a modified click open a tab as normal.
							if (event.metaKey || event.ctrlKey || event.shiftKey) return;
							event.preventDefault();
							void choose(entry);
						}}
					>
						<span class="label">{entry.label}</span>
						{#if entry.hint}<span class="hint">{entry.hint}</span>{/if}
						{#if indexOf(entry) === highlight}
							<CornerDownLeft size={13} strokeWidth={1.75} class="enter" aria-hidden="true" />
						{/if}
					</a>
				{/each}
			{/each}

			{#if shown.length === 0}
				<p class="none">
					Nothing matches "{query}".
					<a class="link" href="/search?q={encodeURIComponent(query)}">Search every record</a>
				</p>
			{/if}
		</div>

		<p class="legend t-meta muted">
			<span>Up and down to move, Enter to go, Escape to close</span>
		</p>
	</div>
</Drawer>

<style>
	/* ------------------------------------------------------------ opener */

	.opener {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: var(--control-h);
		padding: 0 8px;
		border: 1px solid var(--hairline-strong);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text-muted);
		font: inherit;
		cursor: pointer;
		transition:
			background-color var(--speed) var(--ease),
			color var(--speed) var(--ease),
			transform var(--speed) var(--ease);
	}

	.opener:hover {
		background: var(--surface-hover);
		color: var(--text);
	}

	.opener:active {
		transform: scale(0.97);
	}

	kbd {
		font-family: inherit;
		font-size: var(--fs-meta);
		color: var(--text-muted);
		padding: 0 4px;
		border-radius: var(--radius-sm);
		background: var(--surface-sunken);
		box-shadow: inset 0 0 0 1px var(--hairline);
	}

	/* ----------------------------------------------------------- palette */

	.palette {
		display: grid;
		gap: 0;
		min-height: 0;
	}

	.box {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: 0 var(--space-3);
		border-bottom: 1px solid var(--hairline);
		color: var(--text-faint);
	}

	.box input {
		flex: 1 1 auto;
		min-width: 0;
		height: 42px;
		border: 0;
		background: transparent;
		font-size: var(--fs-section);
		padding: 0;
	}

	.box input:focus-visible {
		outline: none;
		box-shadow: none;
	}

	.list {
		overflow: auto;
		min-height: 0;
		max-height: 44dvh;
		padding: var(--space-1) 0;
	}

	.group {
		padding: var(--space-2) var(--space-3) var(--space-1);
		font-size: var(--fs-meta);
		font-weight: 500;
		color: var(--text-muted);
	}

	.row {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		padding: 6px var(--space-3);
		min-height: 30px;
		color: var(--text);
	}

	/* One highlight, moved by the arrows and by the mouse, so there is never
	   a keyboard highlight and a separate hover both claiming to be current. */
	.row.on {
		background: var(--surface-selected);
		box-shadow: inset 2px 0 0 var(--text);
	}

	.row .label {
		font-weight: 500;
	}

	.row .hint {
		flex: 1 1 auto;
		min-width: 0;
		font-size: var(--fs-meta);
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.row :global(.enter) {
		flex: none;
		color: var(--text-muted);
	}

	.none {
		padding: var(--space-4) var(--space-3);
		color: var(--text-muted);
	}

	.legend {
		padding: 6px var(--space-3);
		border-top: 1px solid var(--hairline);
	}

	/* On a phone the label goes and the icon is the button. Typing on a
	   phone is not how anyone uses a palette, but finding it should work. */
	@media (max-width: 720px) {
		.opener-label,
		kbd {
			display: none;
		}

		.opener {
			width: var(--control-h);
			padding: 0;
			justify-content: center;
		}
	}
</style>
