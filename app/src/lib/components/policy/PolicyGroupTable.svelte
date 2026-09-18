<script lang="ts">
	// One group of policies: what each one says company-wide, what it says for
	// the context in the boxes at the top of the page, and what reads it.
	//
	// The "here" column is the point of the table. When it differs from the
	// company-wide value, something has an exception, and the row says so
	// rather than making somebody open each policy to find out.
	import type { PolicyAnswer, PolicyType } from '$lib/policy/types';

	let {
		label,
		blurb,
		types,
		global: globalAnswers,
		here,
		chosenKey,
		href
	}: {
		label: string;
		blurb: string;
		types: PolicyType[];
		global: Record<string, PolicyAnswer> | null;
		here: Record<string, PolicyAnswer> | null;
		chosenKey: string;
		/** Builds the link that opens one policy, keeping the context boxes. */
		href: (key: string) => string;
	} = $props();

	function differs(key: string): boolean {
		const a = globalAnswers?.[key];
		const b = here?.[key];
		if (!a || !b) return false;
		return a.valueWords !== b.valueWords;
	}
</script>

<section class="panel">
	<div class="panel-head">
		<h2>{label}</h2>
		<span class="faint">{blurb}</span>
	</div>
	<div class="table-wrap" tabindex="-1">
		<table>
			<thead>
				<tr>
					<th scope="col">Policy</th>
					<th scope="col">Company-wide</th>
					<th scope="col">Here</th>
					<th scope="col">Read by</th>
				</tr>
			</thead>
			<tbody>
				{#each types as type (type.key)}
					<tr class:is-selected={type.key === chosenKey}>
						<th scope="row">
							<a href={href(type.key)}>{type.name}</a>
							<span class="key faint">{type.key}</span>
						</th>
						<td>
							{#if globalAnswers}
								{globalAnswers[type.key]?.valueWords ?? type.defaultWords}
							{:else}
								<span class="skeleton" style:width="52px" style:height="10px"></span>
							{/if}
						</td>
						<td>
							{#if here}
								<span class:changed={differs(type.key)}>
									{here[type.key]?.valueWords ?? type.defaultWords}
								</span>
								{#if differs(type.key)}
									<span class="chip warn">exception</span>
								{/if}
							{:else}
								<span class="skeleton" style:width="52px" style:height="10px"></span>
							{/if}
						</td>
						<td class="read-by">
							{#if type.readBy === ''}
								<span class="faint">Nothing yet</span>
							{:else}
								<span class="faint">{type.readBy}</span>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</section>

<style>
	th[scope='row'] {
		display: grid;
		gap: 1px;
		font-weight: 500;
		color: var(--text);
		border-bottom: 1px solid var(--hairline);
		white-space: normal;
	}

	.key {
		font-family: var(--font-mono);
		font-size: var(--fs-meta);
	}

	.changed {
		font-weight: 500;
	}

	.read-by {
		max-width: 34ch;
		font-size: var(--fs-meta);
	}

	td {
		white-space: normal;
	}
</style>
