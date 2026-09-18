<script lang="ts">
	// The data dictionary: every field, what it means, where it comes from, and
	// whether it may leave the building.
	import Search from '@lucide/svelte/icons/search';
	import TableSkeleton from '$lib/components/policy/TableSkeleton.svelte';
	import { count } from '$lib/format';
	import type { DictionaryEntity } from '$lib/policy/types';

	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// The filter box. Searching in the browser over a couple of hundred rows is
	// instant and needs no round trip.
	let query = $state('');
	let onlyShareable = $state(false);

	function matches(text: string, needle: string): boolean {
		return text.toLowerCase().includes(needle);
	}

	function filtered(entities: DictionaryEntity[]): DictionaryEntity[] {
		const needle = query.trim().toLowerCase();
		return entities
			.map((entity) => ({
				...entity,
				fields: entity.fields.filter(
					(field) =>
						(!onlyShareable || field.shareable) &&
						(needle === '' ||
							matches(entity.entity, needle) ||
							matches(field.field, needle) ||
							matches(field.label, needle) ||
							matches(field.meaning, needle) ||
							matches(field.derivation, needle))
				)
			}))
			.filter((entity) => entity.fields.length > 0);
	}

	const SOURCE_WORDS: Record<string, string> = {
		'erp export': 'ERP export',
		app: 'the app',
		derived: 'worked out',
		'policy engine': 'policy engine'
	};
</script>

<svelte:head>
	<title>Data dictionary · Northline</title>
</svelte:head>

<main class="page">
	<header class="page-head">
		<div class="titles">
			<h1>Data dictionary</h1>
			<p class="faint">
				Every field a person or an agent reads, in one sentence each: what it means, what it is measured
				in, whether it came from the ERP or was worked out here, and whether it may go outside the
				company. The last column is the same question the order desk asks before it sends an email, asked
				one level down, about the field itself.
			</p>
		</div>
	</header>

	<div class="tools panel">
		<label class="find">
			<span class="sr-only">Search the dictionary</span>
			<Search size={14} strokeWidth={1.75} aria-hidden="true" />
			<input
				type="search"
				bind:value={query}
				placeholder="Search a field, a table or a meaning"
				autocomplete="off"
			/>
		</label>
		<label class="only">
			<input type="checkbox" bind:checked={onlyShareable} />
			Only what may leave the building
		</label>
	</div>

	{#await data.gaps then gaps}
		{#if gaps.length > 0}
			<p class="notice warning" role="status">
				{count(gaps.length)}
				{gaps.length === 1 ? 'field has' : 'fields have'} fallen out of step with the schema:
				{gaps
					.slice(0, 4)
					.map((gap) => `${gap.entity}.${gap.field} (${gap.problem})`)
					.join(', ')}.
			</p>
		{/if}
	{/await}

	{#await data.entities}
		<section class="panel">
			<div class="panel-head"><h2>Loading the dictionary</h2></div>
			<TableSkeleton rows={8} label="Loading the dictionary" />
		</section>
	{:then entities}
		{@const shown = filtered(entities)}
		{#if shown.length === 0}
			<p class="empty">
				Nothing matches "{query}".
				<button class="button" type="button" onclick={() => (query = '')}>Clear the search</button>
			</p>
		{:else}
			{#each shown as entity (entity.entity)}
				<section class="panel">
					<div class="panel-head">
						<h2>{entity.entity}</h2>
						<span class="faint">
							{count(entity.fields.length)}
							{entity.fields.length === 1 ? 'field' : 'fields'}, {count(entity.shareableCount)} of them
							shareable
						</span>
					</div>
					<div class="table-wrap" tabindex="-1">
						<table>
							<thead>
								<tr>
									<th scope="col">Field</th>
									<th scope="col">Means</th>
									<th scope="col">Unit</th>
									<th scope="col">From</th>
									<th scope="col">Example</th>
									<th scope="col">May leave</th>
								</tr>
							</thead>
							<tbody>
								{#each entity.fields as field (field.field)}
									<tr>
										<th scope="row">
											<span class="mono">{field.field}</span>
											<span class="faint">{field.label}</span>
										</th>
										<td class="meaning">
											{field.meaning}
											{#if field.derivation !== ''}
												<span class="faint">{field.derivation}</span>
											{/if}
										</td>
										<td class="faint nowrap">{field.unit === '' ? '·' : field.unit}</td>
										<td class="faint nowrap">{SOURCE_WORDS[field.source] ?? field.source}</td>
										<td class="mono faint">{field.example === '' ? '·' : field.example}</td>
										<td class="nowrap">
											{#if field.shareable}
												<span class="chip">yes</span>
											{:else}
												<span class="chip warn">inside only</span>
											{/if}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				</section>
			{/each}
		{/if}
	{:catch}
		<p class="notice error" role="alert">
			The dictionary could not be loaded.
			<a class="button" href="/dictionary" data-sveltekit-reload>Try again</a>
		</p>
	{/await}
</main>

<style>
	.tools {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-2) var(--space-3);
	}

	.find {
		flex: 1 1 260px;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: var(--space-2);
		color: var(--text-faint);
	}

	.find input {
		flex: 1 1 auto;
		min-width: 0;
	}

	.only {
		display: flex;
		flex-direction: row;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--fs-body);
		color: var(--text-muted);
	}

	th[scope='row'] {
		display: grid;
		gap: 1px;
		font-weight: 500;
		color: var(--text);
		border-bottom: 1px solid var(--hairline);
		white-space: normal;
		max-width: 22ch;
	}

	.mono {
		font-family: var(--font-mono);
		font-size: var(--fs-meta);
	}

	.meaning {
		display: grid;
		gap: 2px;
		max-width: 56ch;
		white-space: normal;
	}

	.meaning .faint {
		font-size: var(--fs-meta);
	}

	.nowrap {
		white-space: nowrap;
	}
</style>
