<script lang="ts">
	// The small chips a part can carry. Warnings (short on open orders, below
	// the reorder point, blocked) use the warning color; facts do not.
	import { count } from '$lib/format';
	import type { PartFlags } from './types';

	let { part, compact = false }: { part: PartFlags; compact?: boolean } = $props();
</script>

<span class="flags">
	{#if part.blocked}<span class="chip warn">Blocked</span>{/if}
	{#if part.shortQty > 0}
		<span class="chip warn" title="Open orders ask for more than is on hand">
			Short {count(part.shortQty)}
		</span>
	{/if}
	{#if part.belowReorderPoint}
		<span class="chip warn" title="On hand plus incoming, less open orders, is under the reorder point">
			{compact ? 'Reorder' : 'Below reorder point'}
		</span>
	{/if}
	{#if part.madeToOrder}<span class="chip">{compact ? 'MTO' : 'Made to order'}</span>{/if}
	{#if part.proprietary}<span class="chip">Proprietary</span>{/if}
</span>

<style>
	.flags {
		display: inline-flex;
		flex-wrap: wrap;
		gap: 4px;
		vertical-align: middle;
	}

	.flags:empty {
		display: none;
	}
</style>
