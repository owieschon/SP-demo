<script lang="ts">
	// Settings: keys and models, mail desks, jobs, health.
	//
	// There is no +layout for this folder on purpose: another branch adds
	// /settings/mcp, and a layout here would decide that page's shell before
	// it exists.
	import ClaimForm from '$lib/components/settings/ClaimForm.svelte';
	import HealthPanel from '$lib/components/settings/HealthPanel.svelte';
	import HealthSkeleton from '$lib/components/settings/HealthSkeleton.svelte';
	import SettingField from '$lib/components/settings/SettingField.svelte';
	import {
		JOBS,
		KEYS_AND_MODELS,
		MAIL_DESKS,
		newSecretInBrowser,
		type SettingView
	} from '$lib/components/settings/types';
	import UnlockForm from '$lib/components/settings/UnlockForm.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	// Each action says where its answer belongs, so a refusal shows next to the
	// field or the form that caused it (see +page.server.ts).
	const answerFrom = (from: string, key?: string) => {
		if (!form || form.from !== from) return null;
		// Only the field actions carry a key; the rest answer their own form.
		const answeredKey = 'key' in form ? form.key : undefined;
		if (key !== undefined && answeredKey !== key) return null;
		return { message: form.message, ok: form.ok };
	};

	const byKey = $derived(new Map<string, SettingView>(data.settings.map((setting) => [setting.key, setting])));
	const section = (keys: readonly string[]): SettingView[] =>
		keys.map((key) => byKey.get(key)).filter((setting): setting is SettingView => Boolean(setting));

	const versionOf = (key: string) => data.versions[key] ?? '';
</script>

<svelte:head>
	<title>Settings · Northline</title>
</svelte:head>

<main class="page">
	<header class="head">
		<h1>Settings</h1>
		<p class="faint">
			Keys, mail desks, the scheduled run and the health of this deployment. A key pasted here is stored
			encrypted and never shown again: the page can only say that it is set, its last four characters and
			when it changed.
		</p>
	</header>

	{#if !data.claimed}
		<ClaimForm minLength={data.minPasscode} unlockHours={data.unlockHours} answer={answerFrom('claim')} />
	{:else}
		<UnlockForm
			unlocked={data.unlocked}
			unlockHours={data.unlockHours}
			minLength={data.minPasscode}
			passcodeUpdatedAt={data.passcodeUpdatedAt}
			unlockAnswer={answerFrom('unlock')}
			passcodeAnswer={answerFrom('passcode')}
		/>
	{/if}

	<section class="panel">
		<header class="panel-head">
			<h2>Keys and models</h2>
			<span class="faint">what Ask Northline and the RFQ reader use</span>
		</header>
		{#each section(KEYS_AND_MODELS) as setting, i (setting.key)}
			<SettingField
				{setting}
				version={versionOf(setting.key)}
				unlocked={data.unlocked}
				answer={answerFrom('save', setting.key) ?? answerFrom('clear', setting.key)}
				first={i === 0}
			/>
		{/each}
	</section>

	<section class="panel">
		<header class="panel-head">
			<h2>Mail desks</h2>
			<span class="faint">the order desk and the procurement desk</span>
		</header>
		<p class="warn">
			The allowed recipients list is the only list this app may ever send to. A draft addressed to anybody
			else is refused, not sent. Keep it to addresses you own.
		</p>
		{#each section(MAIL_DESKS) as setting, i (setting.key)}
			<SettingField
				{setting}
				version={versionOf(setting.key)}
				unlocked={data.unlocked}
				answer={answerFrom('save', setting.key) ?? answerFrom('clear', setting.key)}
				first={i === 0}
			/>
		{/each}
	</section>

	<section class="panel">
		<header class="panel-head">
			<h2>Jobs</h2>
			<span class="faint">the nightly rebuild and the scheduled automation run</span>
		</header>
		{#each section(JOBS) as setting, i (setting.key)}
			<SettingField
				{setting}
				version={versionOf(setting.key)}
				unlocked={data.unlocked}
				answer={answerFrom('save', setting.key) ?? answerFrom('clear', setting.key)}
				first={i === 0}
				suggest={{ label: 'Make one', make: newSecretInBrowser }}
			/>
		{/each}
		<div class="jobs-note">
			<p class="faint">
				There is no "rebuild the world now" button here, and that is deliberate. A rebuild empties every
				table in the world and fills it again, takes about a minute and a half, and holds its locks until
				it commits, so every page waits on it. This app has no queue to run that in, and a serverless
				request is cut off long before it would finish, so a button would leave a half-built world behind.
				On Supabase the pg_cron job in <span class="mono">db/migrations/0012_nightly.supabase.sql</span>
				does it at 00:10 Chicago time; by hand it is
				<span class="mono">node --env-file=.env scripts/db-remote.ts rebuild</span> from
				<span class="mono">app/</span>. Locally the world rebuilds itself when the date changes.
			</p>
			<p class="faint">
				The last run, and whether it worked, is the first thing in Health below.
			</p>
		</div>
	</section>

	<!-- The checks run on the server and stream in after the page (see +page.server.ts). -->
	{#await data.diagnostics}
		<HealthSkeleton />
	{:then diagnostics}
		<HealthPanel {diagnostics} />
	{:catch}
		<p class="notice error" role="alert">
			The health checks could not be run.
			<a class="button" href="/settings" data-sveltekit-reload>Try again</a>
		</p>
	{/await}
</main>

<style>
	.page {
		max-width: 1180px;
		margin: 0 auto;
		padding: var(--space-3) var(--space-4) var(--space-6);
		/* Flexbox in a column, not grid: Safari on iOS and Chromium agree on it. */
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}

	.head p {
		margin: 0;
		max-width: 80ch;
		font-size: 0.92rem;
	}

	.warn {
		margin: 0;
		padding: var(--space-2) var(--space-3);
		border-bottom: 1px solid var(--hairline);
		max-width: 90ch;
		color: var(--warning);
		font-size: 0.88rem;
	}

	.jobs-note {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-3);
		border-top: 1px solid var(--hairline);
	}

	.jobs-note p {
		margin: 0;
		max-width: 90ch;
		font-size: 0.88rem;
	}
</style>
