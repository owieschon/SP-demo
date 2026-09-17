<script lang="ts">
	// The app shell: a left rail (icons, expands over the content on hover or
	// keyboard focus), a slim top bar, and the page. Signed-out pages (sign in)
	// get no shell, only the portfolio note.
	import '@fontsource-variable/geist';
	import '@fontsource-variable/geist-mono';
	import '../app.css';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Inbox from '@lucide/svelte/icons/inbox';
	import ListChecks from '@lucide/svelte/icons/list-checks';
	import LogOut from '@lucide/svelte/icons/log-out';
	import UserRoundArrowLeft from '@lucide/svelte/icons/user-round-arrow-left';
	import Warehouse from '@lucide/svelte/icons/warehouse';
	import Workflow from '@lucide/svelte/icons/workflow';
	import { navigating, page } from '$app/state';
	import Mark from '$lib/components/Mark.svelte';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();

	// The browser-tab icon is the Northline mark, drawn inline.
	const favicon =
		'data:image/svg+xml,' +
		encodeURIComponent(
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0d4a47"/><path d="M10 23V9h2.2l7.6 10V9H22v14h-2.2l-7.6-10v10z" fill="#e6f2f0"/></svg>'
		);

	const NAV = [
		{ href: '/commitments', label: 'Commitments', icon: ListChecks },
		{ href: '/rfq', label: 'RFQ intake', icon: Inbox },
		{ href: '/operations', label: 'Operations', icon: Warehouse },
		{ href: '/automations', label: 'Automations', icon: Workflow }
	];

	// "Pat Doe" -> "PD"
	const initials = $derived(
		(data.user?.fullName ?? '')
			.split(/\s+/)
			.filter(Boolean)
			.map((part) => part[0])
			.slice(0, 2)
			.join('')
			.toUpperCase()
	);

	// The top bar's breadcrumb, worked out from the route.
	// Pages that load `who` (the board and the answer page) get the Mine /
	// Everyone switch.
	const who = $derived(page.data.who === 'mine' || page.data.who === 'all' ? page.data.who : null);
	const boardHref = $derived(who ? `/commitments?who=${who}` : '/commitments');
	const crumbs = $derived.by(() => {
		const route = page.route.id ?? '';
		if (route === '/commitments') return [{ label: 'Commitments', href: null }];
		if (route === '/commitments/answer') {
			return [
				{ label: 'Commitments', href: boardHref },
				{ label: 'Closed short', href: null }
			];
		}
		if (route === '/commitments/[id=id]') {
			return [
				{ label: 'Commitments', href: '/commitments' },
				{ label: `C-${page.params.id}`, href: null }
			];
		}
		if (route === '/rfq') return [{ label: 'RFQ intake', href: null }];
		if (route === '/rfq/[id=id]') {
			return [
				{ label: 'RFQ intake', href: '/rfq' },
				{ label: `R-${page.params.id}`, href: null }
			];
		}
		if (route === '/automations') return [{ label: 'Automations', href: null }];
		if (route === '/automations/new') {
			return [
				{ label: 'Automations', href: '/automations' },
				{ label: 'New rule', href: null }
			];
		}
		if (route === '/automations/[id=id]') {
			return [
				{ label: 'Automations', href: '/automations' },
				{ label: `Rule ${page.params.id}`, href: null }
			];
		}
		if (route.startsWith('/operations')) return [{ label: 'Operations', href: null }];
		if (page.error) return [{ label: page.status === 404 ? 'Not found' : 'Error', href: null }];
		return [];
	});

	function whoHref(value: 'mine' | 'all') {
		const params = new URLSearchParams(page.url.search);
		params.set('who', value);
		return `?${params}`;
	}
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<!-- A thin bar while the next page loads. -->
{#if navigating.to}
	<div class="loading-bar" aria-hidden="true"></div>
{/if}

{#if data.user}
	<div class="shell">
		<nav class="rail" aria-label="Main">
			<a class="brand item pressable" href="/commitments">
				<Mark size={24} />
				<span class="label brand-name">Northline</span>
			</a>

			<ul class="items">
				{#each NAV as item (item.href)}
					<li>
						<a
							class="item pressable"
							href={item.href}
							aria-current={page.url.pathname.startsWith(item.href) ? 'page' : undefined}
						>
							<item.icon size={16} strokeWidth={1.75} aria-hidden="true" />
							<span class="label">{item.label}</span>
						</a>
					</li>
				{/each}
			</ul>

			<div class="foot">
				<div class="me" title="{data.user.fullName}, {data.user.title}">
					<span class="avatar" aria-hidden="true">{initials}</span>
					<span class="label who">
						<span class="name">{data.user.fullName}</span>
						<span class="title">{data.user.title}</span>
					</span>
				</div>
				<a class="item pressable" href="/signin">
					<UserRoundArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
					<span class="label">Switch user</span>
				</a>
				<form method="POST" action="/signout">
					<button class="item pressable">
						<LogOut size={16} strokeWidth={1.75} aria-hidden="true" />
						<span class="label">Sign out</span>
					</button>
				</form>
			</div>
		</nav>

		<div class="main">
			<header class="topbar">
				<nav class="crumbs" aria-label="Breadcrumb">
					{#each crumbs as crumb, i (i)}
						{#if i > 0}<ChevronRight size={13} class="sep" aria-hidden="true" />{/if}
						{#if crumb.href}
							<a class="crumb link-quiet" href={crumb.href}>{crumb.label}</a>
						{:else}
							<span class="crumb current" aria-current="page">{crumb.label}</span>
						{/if}
					{/each}
				</nav>

				<div class="tools">
					{#if who}
						<div class="segmented" role="group" aria-label="Whose commitments">
							<a href={whoHref('mine')} aria-current={who === 'mine' ? 'true' : undefined}>Mine</a>
							<a href={whoHref('all')} aria-current={who === 'all' ? 'true' : undefined}>Everyone</a>
						</div>
					{/if}
					<ThemeToggle />
					<span class="portfolio-note" role="note">Portfolio app · all data is invented</span>
				</div>
			</header>

			{@render children()}
		</div>
	</div>
{:else}
	<div class="portfolio-note standalone" role="note">Portfolio app · all data is invented</div>
	{@render children()}
{/if}

<style>
	/* ------------------------------------------------------------ rail */

	.shell {
		min-height: 100dvh;
		padding-left: var(--rail-w);
	}

	.rail {
		position: fixed;
		inset: 0 auto 0 0;
		z-index: 30;
		width: var(--rail-w);
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 10px 8px;
		overflow: hidden;
		background: var(--bg);
		border-right: 1px solid var(--hairline);
		transition:
			width var(--speed-slow) var(--ease),
			box-shadow var(--speed-slow) var(--ease),
			background-color var(--speed-slow) var(--ease);
	}

	/*
	  Hover or keyboard focus opens the rail OVER the page. The page's own
	  padding stays at the collapsed width, so nothing underneath moves.
	*/
	.rail:hover,
	.rail:focus-within {
		width: var(--rail-open-w);
		background: var(--surface);
		box-shadow: var(--overlay-shadow);
	}

	.items {
		list-style: none;
		margin: 10px 0 0;
		padding: 0;
		display: grid;
		gap: 2px;
	}

	.item {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		height: 32px;
		padding: 0 10px;
		border: 0;
		border-radius: var(--radius);
		background: transparent;
		color: var(--text-muted);
		font: inherit;
		font-weight: 500;
		white-space: nowrap;
		cursor: pointer;
		-webkit-tap-highlight-color: transparent;
		transition:
			background-color var(--speed) var(--ease),
			color var(--speed) var(--ease),
			transform var(--speed) var(--ease);
	}

	.item :global(svg) {
		flex: none;
	}

	.item:hover {
		background: var(--surface-hover);
		color: var(--text);
	}

	.item[aria-current='page'] {
		background: var(--surface-press);
		color: var(--text);
	}

	.brand {
		padding: 0 6px;
		color: var(--text);
	}

	.brand-name {
		font-weight: 600;
		letter-spacing: -0.01em;
	}

	/* Labels fade in once the rail has room for them. */
	.label {
		opacity: 0;
		transition: opacity var(--speed) var(--ease);
	}

	.rail:hover .label,
	.rail:focus-within .label {
		opacity: 1;
		transition-delay: 60ms;
	}

	.foot {
		margin-top: auto;
		display: grid;
		gap: 2px;
		padding-top: 8px;
		border-top: 1px solid var(--hairline);
	}

	.me {
		display: flex;
		align-items: center;
		gap: 10px;
		height: 36px;
		padding: 0 5px;
		white-space: nowrap;
	}

	.avatar {
		flex: none;
		width: 26px;
		height: 26px;
		border-radius: 50%;
		display: grid;
		place-items: center;
		font-size: 0.78rem;
		font-weight: 600;
		letter-spacing: 0.02em;
		color: var(--text);
		background: var(--surface-press);
		box-shadow: inset 0 0 0 1px var(--hairline-strong);
	}

	.who {
		display: grid;
		line-height: 1.2;
		min-width: 0;
	}

	.who .name {
		font-weight: 500;
	}

	.who .title {
		font-size: 0.85rem;
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.foot form {
		margin: 0;
	}

	/* --------------------------------------------------------- top bar */

	.topbar {
		position: sticky;
		top: 0;
		z-index: 20;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		height: var(--topbar-h);
		padding: 0 var(--space-4);
		background: color-mix(in srgb, var(--bg) 85%, transparent);
		-webkit-backdrop-filter: blur(10px);
		backdrop-filter: blur(10px);
		border-bottom: 1px solid var(--hairline);
	}

	.crumbs {
		display: flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
		font-weight: 500;
	}

	.crumbs :global(.sep) {
		flex: none;
		color: var(--text-faint);
	}

	.crumb {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		padding: 2px 4px;
		border-radius: var(--radius-sm);
	}

	.link-quiet {
		color: var(--text-muted);
		transition:
			color var(--speed) var(--ease),
			background-color var(--speed) var(--ease);
	}

	.link-quiet:hover {
		color: var(--text);
		background: var(--surface-hover);
	}

	.current {
		color: var(--text);
	}

	.tools {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex: none;
	}

	.portfolio-note {
		font-size: 0.82rem;
		color: var(--text-faint);
		white-space: nowrap;
	}

	.tools .portfolio-note {
		margin-left: var(--space-1);
		padding-left: var(--space-3);
		border-left: 1px solid var(--hairline);
	}

	.portfolio-note.standalone {
		padding: 6px var(--space-4);
		text-align: center;
		border-bottom: 1px solid var(--hairline);
	}

	/* ------------------------------------------------------ loading bar */

	.loading-bar {
		position: fixed;
		top: 0;
		left: 0;
		height: 2px;
		width: 100%;
		z-index: 50;
		background: var(--text);
		opacity: 0.55;
		transform-origin: left;
		animation: grow 1.4s var(--ease) infinite;
	}

	@keyframes grow {
		from {
			transform: scaleX(0);
		}
		to {
			transform: scaleX(1);
		}
	}

	/* ----------------------------------------------------------- phone */

	/*
	  On a phone the rail becomes a bottom bar: icons only, no hover
	  expansion. The portfolio note drops under the top bar's tools.
	*/
	@media (max-width: 720px) {
		.shell {
			padding-left: 0;
			padding-bottom: calc(var(--rail-w) + env(safe-area-inset-bottom));
		}

		.rail,
		.rail:hover,
		.rail:focus-within {
			inset: auto 0 0 0;
			width: auto;
			height: calc(var(--rail-w) + env(safe-area-inset-bottom));
			flex-direction: row;
			align-items: center;
			justify-content: space-around;
			padding: 0 var(--space-2) env(safe-area-inset-bottom);
			border-right: 0;
			border-top: 1px solid var(--hairline);
			background: color-mix(in srgb, var(--bg) 92%, transparent);
			-webkit-backdrop-filter: blur(10px);
			backdrop-filter: blur(10px);
			box-shadow: none;
		}

		.brand,
		.me,
		.label {
			display: none;
		}

		.items,
		.foot {
			display: contents;
		}

		.item {
			width: 44px;
			height: 44px;
			justify-content: center;
			padding: 0;
		}

		.topbar {
			height: auto;
			min-height: var(--topbar-h);
			flex-wrap: wrap;
			padding: 6px var(--space-3);
			row-gap: 4px;
		}

		.tools {
			flex-wrap: wrap;
		}

		.tools .portfolio-note {
			flex-basis: 100%;
			margin: 0;
			padding: 0;
			border: 0;
			order: 3;
		}
	}
</style>
