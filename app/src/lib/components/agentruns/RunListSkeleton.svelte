<script lang="ts">
	// The run list's shape while it loads: eight columns, a table row's own
	// height, so nothing jumps when the rows arrive.
	import SkeletonRows from '$lib/components/ui/SkeletonRows.svelte';

	let { rows = 8, label = 'Loading the agent runs' }: { rows?: number; label?: string } = $props();
</script>

<SkeletonRows {rows} cols={8} height={32} header {label} />
