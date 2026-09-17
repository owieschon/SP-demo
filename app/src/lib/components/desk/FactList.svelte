<script lang="ts">
	// The facts a draft rests on, each with a link to the record it came from.
	//
	// This list is not decoration. It is what the disclosure policy checked
	// (app/src/lib/server/desk/policy.ts), so a reviewer reading it is reading
	// exactly what the check read.
	import type { Fact, FactKind } from '$lib/desk/types';

	let { facts, heading = 'What it used' }: { facts: Fact[]; heading?: string } = $props();

	const KIND_LABEL: Record<FactKind, string> = {
		account_identity: 'Account',
		part_description: 'Part',
		own_price: 'Their price',
		quantity_break: 'Quantity break',
		own_past_price: 'What they paid',
		own_agreement: 'Their agreement',
		availability: 'Availability',
		lead_time: 'Lead time',
		own_open_order: 'Their order',
		own_quote: 'Their quote',
		own_commitment: 'Their commitment',
		own_rep: 'Their rep',
		freight: 'Freight',
		vendor_supply: 'Supplier order',
		vendor_lead_time: 'Supplier lead time',
		stock_quantity: 'Stock on hand',
		unit_cost: 'Our cost',
		margin: 'Our margin',
		floor_price: 'Price floor',
		other_customer: 'Another account',
		internal_note: 'Internal note',
		colleague_name: 'A colleague'
	};
</script>

{#if facts.length > 0}
	<section class="facts" aria-label={heading}>
		<h4>{heading} <span class="faint">({facts.length})</span></h4>
		<ul>
			{#each facts as fact, i (i)}
				<li>
					<span class="kind">{KIND_LABEL[fact.kind] ?? fact.kind}</span>
					<span class="what">{fact.text}</span>
					{#if fact.href}
						<a class="link" href={fact.href}>Open</a>
					{/if}
				</li>
			{/each}
		</ul>
	</section>
{/if}

<style>
	.facts {
		display: grid;
		gap: 6px;
	}

	h4 {
		font-size: 0.85rem;
		font-weight: 500;
		color: var(--text-muted);
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
	}

	li {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--space-2);
		padding: 5px 0;
		font-size: 0.9rem;
	}

	li + li {
		border-top: 1px solid var(--hairline);
	}

	.kind {
		flex: none;
		width: 132px;
		color: var(--text-faint);
		font-size: 0.82rem;
	}

	.what {
		flex: 1;
		min-width: 200px;
	}

	@media (max-width: 720px) {
		.kind {
			width: auto;
		}
	}
</style>
