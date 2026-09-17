<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import { navigating, page } from '$app/state';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();

	const NAV = [{ href: '/commitments', label: 'Commitments' }];
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<div class="portfolio-label" role="note">Portfolio app · all data is invented</div>

{#if data.user}
	<header class="topbar">
		<a class="brand" href="/commitments">
			<span class="mark" aria-hidden="true">N</span>
			<span>Northline</span>
		</a>
		<nav aria-label="Main">
			{#each NAV as item (item.href)}
				<a href={item.href} aria-current={page.url.pathname.startsWith(item.href) ? 'page' : undefined}>
					{item.label}
				</a>
			{/each}
		</nav>
		<div class="me">
			<span class="who">
				<span class="name">{data.user.fullName}</span>
				<span class="faint">{data.user.title}</span>
			</span>
			<a class="button quiet" href="/signin">Switch</a>
			<form method="POST" action="/signout">
				<button class="button quiet">Sign out</button>
			</form>
		</div>
	</header>
{/if}

<!-- A thin bar while the next page loads. -->
{#if navigating.to}
	<div class="loading-bar" aria-hidden="true"></div>
{/if}

{@render children()}

<style>
	.portfolio-label {
		padding: 4px var(--space-4);
		font-size: 0.78rem;
		text-align: center;
		color: var(--text-muted);
		background: var(--surface-sunken);
		border-bottom: 1px solid var(--hairline);
	}

	.topbar {
		position: sticky;
		top: 0;
		z-index: 10;
		display: flex;
		align-items: center;
		gap: var(--space-5);
		padding: var(--space-2) var(--space-4);
		background: color-mix(in srgb, var(--bg) 88%, transparent);
		backdrop-filter: blur(8px);
		border-bottom: 1px solid var(--hairline);
	}

	.brand {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-weight: 600;
		color: var(--text);
	}

	.brand:hover {
		text-decoration: none;
	}

	.mark {
		width: 24px;
		height: 24px;
		border-radius: 6px;
		display: grid;
		place-items: center;
		background: var(--accent);
		color: var(--accent-text);
		font-size: 0.8rem;
		font-weight: 700;
	}

	nav {
		display: flex;
		gap: var(--space-1);
		flex: 1;
	}

	nav a {
		padding: 6px 10px;
		border-radius: var(--radius);
		color: var(--text-muted);
	}

	nav a:hover {
		background: var(--surface-sunken);
		text-decoration: none;
	}

	nav a[aria-current='page'] {
		color: var(--text);
		background: var(--surface-sunken);
	}

	.me {
		display: flex;
		align-items: center;
		gap: var(--space-1);
	}

	.who {
		display: grid;
		text-align: right;
		line-height: 1.2;
		margin-right: var(--space-2);
		font-size: 0.85rem;
	}

	.name {
		font-weight: 500;
	}

	.loading-bar {
		position: fixed;
		top: 0;
		left: 0;
		height: 2px;
		width: 100%;
		z-index: 20;
		background: var(--accent);
		transform-origin: left;
		animation: grow 1.2s var(--ease) infinite;
	}

	@keyframes grow {
		from {
			transform: scaleX(0);
		}
		to {
			transform: scaleX(1);
		}
	}

	@media (max-width: 640px) {
		.topbar {
			flex-wrap: wrap;
			gap: var(--space-2);
		}

		.who {
			display: none;
		}

		nav {
			order: 3;
			flex-basis: 100%;
		}
	}
</style>
