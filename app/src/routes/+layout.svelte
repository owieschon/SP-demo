<script lang="ts">
	/*
	  The app shell: a sidebar, a slim top bar, and the page. Signed-out pages
	  (sign in, the gate) get no shell, only the demo note.

	  Two things changed here and both were deliberate.

	  The sidebar no longer hides. It used to be a 52px rail of icons that
	  expanded over the page on hover, which meant the group headings could not
	  be shown at all, and the effect that kept the current item in view
	  scrolled the icons off screen on every desktop navigation. Group headings
	  are labels a person reads, not dividers, so the sidebar is open, 216px,
	  and the four groups say what they are.

	  On a phone it is a bottom bar with exactly two entries plus the palette:
	  Today, and the desk this person works. A bar of twelve icons that scrolls
	  sideways is not navigation, it is a list most of which is off screen.
	*/
	import '@fontsource-variable/geist';
	import '@fontsource-variable/geist-mono';
	import '../app.css';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import LogOut from '@lucide/svelte/icons/log-out';
	import UserRoundArrowLeft from '@lucide/svelte/icons/user-round-arrow-left';
	import { navigating, page } from '$app/state';
	import { count } from '$lib/format';
	import CommandPalette from '$lib/components/ui/CommandPalette.svelte';
	import PaletteButton from '$lib/components/ui/PaletteButton.svelte';
	import Mark from '$lib/components/Mark.svelte';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';
	import Toast from '$lib/components/ui/Toast.svelte';
	import { NAV_ITEMS, phoneItems, visibleSections } from '$lib/nav';
	import { railItems, railSections } from '$lib/roles/rail';
	import { routes } from '$lib/routes';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();

	/*
	  Two pages get no shell even when somebody is signed in: the sign-in
	  picker and the password curtain. The curtain in particular is in FRONT
	  of the app, so drawing the rail, the person's name and a sign-out button
	  around it says the opposite of what it means, and offers controls that
	  cannot work until the password is typed. Keyed on the route rather than
	  on data.user, because a signed-in person is exactly who sees the curtain
	  when it expires.
	*/
	const BARE = ['/gate', '/signin'];
	const bare = $derived(BARE.some((path) => page.url.pathname === path));

	// The browser-tab icon is the Northline mark, drawn inline.
	const favicon =
		'data:image/svg+xml,' +
		encodeURIComponent(
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0d4a47"/><path d="M10 23V9h2.2l7.6 10V9H22v14h-2.2l-7.6-10v10z" fill="#e6f2f0"/></svg>'
		);

	/*
	  The rail is DERIVED. +layout.server.ts works out which entries this person
	  has a reason to see, from what they may decide and what is theirs
	  ($lib/roles/rail.ts), and nav.ts was written to survive a group being
	  emptied. An entry with nothing behind it is hidden rather than greyed,
	  because a greyed control is a question and a missing one is an answer.

	  Hiding an entry hides the ENTRY. Every page stays reachable by its URL
	  and through the palette, so somebody covering for a colleague can still
	  open the screen once.
	*/
	const sections = $derived(visibleSections(railSections(data.rail)));
	const phone = $derived(railItems(phoneItems(data.user?.role ?? 'account_manager'), data.rail));


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
	/*
	  A page that knows both sizes passes them, and the switch says so, because
	  a switch whose two sides look identical until you press one is a dare
	  rather than a choice. A page that does not pass them gets the plain
	  labels it had before.
	*/
	const whoCounts = $derived(
		page.data.whoCounts && typeof page.data.whoCounts.everyone === 'number'
			? (page.data.whoCounts as { mine: number; everyone: number })
			: null
	);
	const boardHref = $derived(who ? routes.commitments(who) : routes.commitments());
	const crumbs = $derived.by(() => {
		const route = page.route.id ?? '';
		if (route === '/') return [{ label: 'Today', href: null }];
		if (route === '/commitments') return [{ label: 'Commitments', href: null }];
		if (route === '/commitments/answer') {
			return [
				{ label: 'Commitments', href: boardHref },
				{ label: 'Closed short', href: null }
			];
		}
		if (route === '/commitments/[id=id]') {
			return [
				{ label: 'Commitments', href: routes.commitments() },
				{ label: `C-${page.params.id}`, href: null }
			];
		}
		if (route === '/quotes/[id=id]') return [{ label: `Quote SQ-${page.params.id}`, href: null }];
		if (route === '/workspace') return [{ label: 'Approval queue', href: null }];
		if (route === '/desk') return [{ label: 'Order desk', href: null }];
		if (route === '/desk/[id=id]') {
			return [
				{ label: 'Order desk', href: routes.desk() },
				{ label: 'Item', href: null }
			];
		}
		// Quote requests were a section of their own. They arrive at the desk,
		// so they live under it.
		if (route === '/desk/requests/[id=id]') {
			return [
				{ label: 'Order desk', href: routes.desk() },
				{ label: `Quote request R-${page.params.id}`, href: null }
			];
		}
		if (route === '/settings') return [{ label: 'Settings', href: null }];
		if (route === '/settings/mcp') {
			return [
				{ label: 'Settings', href: routes.settings() },
				{ label: 'Coding agents', href: null }
			];
		}
		if (route === '/ask') return [{ label: 'Ask', href: null }];
		if (route === '/ask/[id=id]') {
			return [
				{ label: 'Ask', href: routes.ask() },
				{ label: `Conversation ${page.params.id}`, href: null }
			];
		}
		if (route === '/accounts') return [{ label: 'Accounts', href: null }];
		if (route === '/accounts/[customer=customer]') {
			return [
				{ label: 'Accounts', href: routes.accounts() },
				{ label: page.data.account?.name ?? page.params.customer, href: null }
			];
		}
		if (route === '/parts') return [{ label: 'Parts', href: null }];
		if (route === '/parts/[item=item]') {
			return [
				{ label: 'Parts', href: routes.parts() },
				{ label: page.params.item ?? '', href: null }
			];
		}
		if (route === '/vendors') return [{ label: 'Vendors', href: null }];
		if (route === '/vendors/[vendor=vendor]') {
			return [
				{ label: 'Vendors', href: routes.vendors() },
				{ label: page.params.vendor ?? '', href: null }
			];
		}
		if (route === '/search') return [{ label: 'Search', href: null }];
		if (route === '/automations') return [{ label: 'Automations', href: null }];
		if (route === '/automations/new') {
			return [
				{ label: 'Automations', href: routes.rules() },
				{ label: 'New rule', href: null }
			];
		}
		if (route === '/automations/[id=id]') {
			return [
				{ label: 'Automations', href: routes.rules() },
				{ label: `Rule ${page.params.id}`, href: null }
			];
		}
		if (route === '/operations/forecast') return [{ label: 'Open orders', href: null }];
		if (route.startsWith('/operations')) return [{ label: 'Morning exports', href: null }];
		if (route.startsWith('/warehouse')) return [{ label: 'Inventory', href: null }];
		if (page.error) return [{ label: page.status === 404 ? 'Not found' : 'Error', href: null }];
		return [];
	});

	function whoHref(value: 'mine' | 'all') {
		const params = new URLSearchParams(page.url.search);
		params.set('who', value);
		return `?${params}`;
	}

	/*
	  Which entry is the current one. It matches on whole path segments, so
	  /parts/L3515 lights up Parts and a future /parts-catalog would not. The
	  home route is exact, or it would claim every page in the app.
	*/
	function isCurrent(href: string): boolean {
		const path = page.url.pathname;
		if (href === '/') return path === '/';
		// A longer entry wins: /operations/forecast must not also light up
		// /operations, which is in a different group.
		const better = NAV_ITEMS.some(
			(item) =>
				item.href !== href &&
				item.href.startsWith(href + '/') &&
				(path === item.href || path.startsWith(item.href + '/'))
		);
		if (better) return false;
		return path === href || path.startsWith(href + '/');
	}
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<!--
	A thin bar while the next page loads. role="progressbar" with no value
	says "something is happening, length unknown", which is the truth.
-->
{#if navigating.to}
	<div class="loading-bar" role="progressbar" aria-label="Loading the next page"></div>
{/if}

{#if data.user && !bare}
	<!--
		Straight to the page content, for anyone arriving on the keyboard. It
		is the first thing in the tab order and visible only when focused.
	-->
	<a class="skip-link" href="#content">Skip to the page</a>

	<div class="shell">
		<nav class="rail" aria-label="Sections">
			<a class="brand item" href={routes.today()}>
				<Mark size={22} />
				<span class="brand-name">Northline</span>
			</a>

			{#each sections as section (section.heading)}
				<!--
					A real heading per group, with that heading's own list under
					it, so a screen reader reads "Desks, list, three items"
					rather than eleven links in a row.
				-->
				<h2 class="group">{section.heading}</h2>
				<ul class="items">
					{#each section.items as item (item.href)}
						<li>
							<a
								class="item pressable"
								href={item.href}
								aria-current={isCurrent(item.href) ? 'page' : undefined}
							>
								<item.icon size={16} strokeWidth={1.75} aria-hidden="true" />
								<span class="label">{item.label}</span>
							</a>
						</li>
					{/each}
				</ul>
			{/each}

			<div class="foot">
				<div class="me">
					<span class="avatar" aria-hidden="true">{initials}</span>
					<span class="who">
						<span class="name">{data.user.fullName}</span>
						<span class="title">{data.user.title}</span>
					</span>
					<span class="sr-only">Signed in as {data.user.fullName}, {data.user.title}</span>
				</div>
				<a class="item pressable" href={routes.signin()}>
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

		<!--
			The phone bar: two entries and the palette, from nav.ts, rather than
			a sideways scroller holding twelve.
		-->
		<nav class="phone-bar" aria-label="Sections">
			{#each phone as item (item.href)}
				<a
					class="phone-item"
					href={item.href}
					aria-current={isCurrent(item.href) ? 'page' : undefined}
				>
					<item.icon size={18} strokeWidth={1.75} aria-hidden="true" />
					<span>{item.label}</span>
				</a>
			{/each}
			<span class="phone-item palette-slot"><PaletteButton variant="compact" /></span>
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
					<span class="palette-desktop"><PaletteButton /></span>
					{#if who}
						<!--
							The switch says how many are on each side, so choosing the wider
							view is a decision and not a dare. The counts are of the noun the
							page lists, before its other filters; the list's own row count
							says what those left.
						-->
						<div class="segmented" role="group" aria-label="Whose records">
							<a href={whoHref('mine')} aria-current={who === 'mine' ? 'true' : undefined}>
								Mine{#if whoCounts}<span class="tally">{count(whoCounts.mine)}</span>{/if}
							</a>
							<a href={whoHref('all')} aria-current={who === 'all' ? 'true' : undefined}>
								Everyone{#if whoCounts}<span class="tally">{count(whoCounts.everyone)}</span>{/if}
							</a>
						</div>
					{/if}
					<ThemeToggle />
					<span class="demo-note" role="note">Demo app · synthetic data</span>
				</div>
			</header>

			<!--
				The skip link's target. It is a div, not a <main>: every page
				renders its own <main>, through Page.svelte or its own shell
				until it is migrated, and two nested mains is not a document.
			-->
			<div id="content" tabindex="-1">
				{@render children()}
			</div>
		</div>
	</div>

	<!-- One palette for the whole app; the buttons above open it. -->
	<CommandPalette />
	<Toast />
{:else}
	<div class="demo-note standalone" role="note">Demo app · synthetic data</div>
	{@render children()}
{/if}

<style>
	/* --------------------------------------------------------- sidebar */

	.shell {
		min-height: 100dvh;
		padding-left: var(--rail-open-w);
	}

	.rail {
		position: fixed;
		inset: 0 auto 0 0;
		z-index: 30;
		width: var(--rail-open-w);
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 10px 8px;
		overflow-y: auto;
		overscroll-behavior: contain;
		background: var(--bg);
		border-right: 1px solid var(--hairline);
	}

	.group {
		margin: var(--space-3) 0 2px;
		padding: 0 10px;
		font-size: var(--fs-meta);
		font-weight: 500;
		letter-spacing: 0.02em;
		color: var(--text-faint);
	}

	.items {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 1px;
	}

	.item {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		height: 30px;
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

	.item:active {
		transform: scale(0.99);
	}

	/* Selected is a fill plus a marker down the left edge: the same three
	   states every other selected thing in this app uses. */
	.item[aria-current='page'] {
		background: var(--surface-selected);
		color: var(--text);
		box-shadow: inset 2px 0 0 var(--text);
	}

	.brand {
		height: 34px;
		padding: 0 8px;
		margin-bottom: var(--space-2);
		color: var(--text);
		font-size: var(--fs-section);
	}

	.brand-name {
		font-weight: 600;
		letter-spacing: -0.01em;
	}

	.foot {
		margin-top: auto;
		display: grid;
		gap: 1px;
		padding-top: var(--space-2);
		border-top: 1px solid var(--hairline);
	}

	.me {
		display: flex;
		align-items: center;
		gap: 10px;
		height: 36px;
		padding: 0 5px;
		white-space: nowrap;
		min-width: 0;
	}

	.avatar {
		flex: none;
		width: 26px;
		height: 26px;
		border-radius: 50%;
		display: grid;
		place-items: center;
		font-size: var(--fs-meta);
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
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.who .title {
		font-size: var(--fs-meta);
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.foot form {
		margin: 0;
	}

	/* The phone bar does not exist on a desktop. */
	.phone-bar {
		display: none;
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

	.tally {
		margin-left: 6px;
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
	}

	.demo-note {
		font-size: var(--fs-meta);
		color: var(--text-faint);
		white-space: nowrap;
	}

	.tools .demo-note {
		margin-left: var(--space-1);
		padding-left: var(--space-3);
		border-left: 1px solid var(--hairline);
	}

	.demo-note.standalone {
		padding: 6px var(--space-4);
		text-align: center;
		border-bottom: 1px solid var(--hairline);
	}

	/* ------------------------------------------------------ loading bar */

	#content:focus-visible {
		outline: none;
	}

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

	@media (max-width: 720px) {
		.shell {
			padding-left: 0;
			padding-bottom: calc(var(--rail-w) + env(safe-area-inset-bottom));
		}

		/* The sidebar goes entirely. Everything in it is in the palette. */
		.rail {
			display: none;
		}

		.phone-bar {
			position: fixed;
			inset: auto 0 0 0;
			z-index: 30;
			display: flex;
			align-items: center;
			justify-content: space-around;
			height: calc(var(--rail-w) + env(safe-area-inset-bottom));
			padding: 0 var(--space-2) env(safe-area-inset-bottom);
			border-top: 1px solid var(--hairline);
			background: color-mix(in srgb, var(--bg) 92%, transparent);
			-webkit-backdrop-filter: blur(10px);
			backdrop-filter: blur(10px);
		}

		.phone-item {
			flex: 1 1 0;
			display: flex;
			flex-direction: column;
			align-items: center;
			justify-content: center;
			gap: 3px;
			height: calc(var(--rail-w) - 6px);
			border-radius: var(--radius);
			color: var(--text-muted);
			font-size: var(--fs-meta);
			line-height: 1;
			-webkit-tap-highlight-color: transparent;
		}

		.phone-item[aria-current='page'] {
			background: var(--surface-selected);
			color: var(--text);
		}

		.palette-desktop {
			display: none;
		}

		/* The page's own heading names the section on a phone. */
		.crumbs {
			display: none;
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
			width: 100%;
			justify-content: flex-end;
		}

		.tools .demo-note {
			flex: 1 1 auto;
			margin: 0;
			padding: 0;
			border: 0;
			text-align: left;
		}
	}
</style>
