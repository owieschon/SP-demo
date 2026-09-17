<script lang="ts">
	// Northline's logo mark: a small rounded square with an "N".
	// The only place the brand color appears.
	let { size = 24 }: { size?: number } = $props();
</script>

<svg class="mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
	<rect width="32" height="32" rx="8" />
	<path d="M10 23V9h2.2l7.6 10V9H22v14h-2.2l-7.6-10v10z" />
</svg>

<style>
	.mark {
		flex: none;
		display: block;
	}

	rect {
		fill: var(--brand);
	}

	path {
		fill: var(--brand-ink);
	}
</style>
