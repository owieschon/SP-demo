<script lang="ts">
	// The order desk. Two tabs: what came in, and what is waiting for you.
	//
	// The one thing this page has to make unmissable is that the agent cannot
	// send. The banner says so, and every draft below it is a draft.
	import { enhance } from '$app/forms';
	import Lock from '@lucide/svelte/icons/lock';
	import PhoneIncoming from '@lucide/svelte/icons/phone-incoming';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import DeskListSkeleton from '$lib/components/desk/DeskListSkeleton.svelte';
	import DraftCard from '$lib/components/desk/DraftCard.svelte';
	import { INTENT_LABEL, MESSAGE_STATUS_LABEL } from '$lib/desk/types';
	import { moment, percent } from '$lib/format';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let tab = $state<'inbox' | 'outbox'>('outbox');
	let checking = $state(false);
	let reading = $state(false);
	let unlocking = $state(false);
	let request = $state('');
	let sampleName = $state('');
	/** The names of the files chosen, so the person can see what is going up. */
	let attached = $state<string[]>([]);

	// One notice each, because the two forms fail for different reasons.
	const checkMessage = $derived(form && 'message' in form ? form.message : null);
	const entryMessage = $derived(form && 'entryMessage' in form ? form.entryMessage : null);
	const liveMessage = $derived(form && 'liveMessage' in form ? form.liveMessage : null);
	const conflicted = $derived(form !== null && form !== undefined && 'conflict' in form && form.conflict === true);

	function loadSample(name: string) {
		const sample = data.entry.samples.find((s) => s.name === name);
		request = sample?.text ?? '';
		sampleName = sample?.name ?? '';
	}

	const totals = $derived({
		waiting: data.mailboxes.reduce((sum, m) => sum + m.waiting, 0),
		queued: data.mailboxes.reduce((sum, m) => sum + m.queued, 0),
		needsPerson: data.mailboxes.reduce((sum, m) => sum + m.needsPerson, 0),
		approved: data.mailboxes.reduce((sum, m) => sum + m.approved, 0)
	});

	const desk = $derived(data.only === null ? null : data.mailboxes.find((m) => m.id === data.only));
</script>

<svelte:head>
	<title>Desk · Northline</title>
</svelte:head>

<main class="page">
	<header class="head">
		<h1>Desk</h1>
		<p class="faint">
			Mail arrives at the order desk and the procurement desk. The agent reads it, works out what it is,
			looks up what is true for that account, and writes a reply into the queue below.
		</p>
	</header>

	<p class="notice banner" role="note">
		<ShieldCheck size={14} aria-hidden="true" />
		<span><strong>Nothing is sent until you approve.</strong> The agent can only write into this queue.</span>
	</p>

	<section class="panel" aria-labelledby="desks">
		<header class="panel-head">
			<h2 id="desks">Desks</h2>
			<span class="chip">{data.provider.label}</span>
		</header>
		<div class="body desks">
			{#each data.mailboxes as mailbox (mailbox.id)}
				<a
					class="desk"
					class:current={data.only === mailbox.id}
					href={data.only === mailbox.id ? '/desk' : `/desk?desk=${mailbox.id}`}
				>
					<span class="name">{mailbox.label}</span>
					<span class="mono faint small">{mailbox.address}</span>
					<span class="counts small">
						<span>{mailbox.queued} waiting for you</span>
						<span class="faint">·</span>
						<span>{mailbox.messages} messages</span>
						{#if mailbox.needsPerson > 0}
							<span class="faint">·</span>
							<span class="warn">{mailbox.needsPerson} need a person</span>
						{/if}
					</span>
					<span class="faint small">
						Reviewed by {mailbox.reviewerName}. Drafts may say what a {mailbox.disclosure} may hear.
						{mailbox.runsToday} of {mailbox.runsCap} runs used today.
					</span>
				</a>
			{/each}
		</div>
		<div class="body rules">
			<form
				method="POST"
				action="?/check"
				use:enhance={() => {
					checking = true;
					return async ({ update }) => {
						await update();
						checking = false;
					};
				}}
			>
				<button class="button primary" disabled={checking} aria-busy={checking}>
					<RefreshCw size={13} aria-hidden="true" />
					{checking ? 'Checking...' : 'Check mail'}
				</button>
			</form>
			<p class="small faint">
				{#if data.provider.live}
					Live: mail is fetched from AgentMail and an approved reply really goes out.
				{:else}
					No mail key on this server, so this is the scripted demo mailbox: the messages are invented and
					approving records a simulated send. Nothing leaves the building.
				{/if}
				{data.allowlist.describe}
			</p>
		</div>
	</section>

	<details class="panel entry">
		<summary>
			<PhoneIncoming size={13} aria-hidden="true" />
			<span class="name">Add a quote request by hand</span>
			<span class="faint small">for one that came in on the telephone</span>
		</summary>

		<form
			method="POST"
			action="?/enter"
			enctype="multipart/form-data"
			class="body intake"
			use:enhance={() => {
				reading = true;
				return async ({ update }) => {
					await update({ reset: false });
					reading = false;
				};
			}}
		>
			<input type="hidden" name="requestId" value={data.requestId} />
			<input type="hidden" name="sampleName" value={sampleName} />

			<div class="row">
				<label>
					<span>Which desk</span>
					<select name="desk">
						{#each data.mailboxes as mailbox (mailbox.id)}
							<option value={mailbox.id} selected={mailbox.kind === 'orders'}>{mailbox.label}</option>
						{/each}
					</select>
				</label>
				<label>
					<span>Who it came from <span class="faint">(name)</span></span>
					<input name="fromName" autocomplete="off" maxlength="200" placeholder="The buyer who called" />
				</label>
				<label>
					<span>Their email <span class="faint">(if you have it)</span></span>
					<input name="from" type="email" autocomplete="off" maxlength="200" placeholder="buyer@shop.example" />
				</label>
			</div>

			<div class="row">
				<label class="wide">
					<span>What to call it</span>
					<input name="subject" autocomplete="off" maxlength="300" placeholder="Quote for two trucks" />
				</label>
				<label>
					<span>Load a sample <span class="faint">(invented requests)</span></span>
					<select onchange={(e) => loadSample(e.currentTarget.value)} value={sampleName}>
						<option value="">Choose one...</option>
						{#each data.entry.samples as s (s.name)}
							<option value={s.name}>{s.name.slice(0, 2)}. {s.label}</option>
						{/each}
					</select>
				</label>
				<label class="file">
					<span>Anything they sent <span class="faint">(up to four files)</span></span>
					<input
						type="file"
						name="files"
						multiple
						accept={data.entry.accept}
						onchange={(e) => (attached = [...(e.currentTarget.files ?? [])].map((f) => f.name))}
					/>
				</label>
			</div>

			{#if attached.length > 0}
				<p class="faint small">Attached: {attached.join(', ')}</p>
			{/if}

			<label>
				<span>What they asked for</span>
				<textarea
					name="email"
					rows="8"
					class="mono"
					spellcheck="false"
					placeholder={'Called about a second truck to the same spec.\n\n  L760-128B  qty 12\n  S5-48KS  qty 2\n\nNeeded by October 5. Freight to Mobile.'}
					bind:value={request}
					oninput={() => (sampleName = '')}
				></textarea>
			</label>

			<p class="faint small">
				Read the same way an emailed request is: spreadsheets, PDFs and CSV parts lists are all read, a table
				wins over prose, and every line says which file, sheet and row it came from. Nothing is created until
				somebody approves it.
			</p>

			{#if entryMessage}
				<p class="notice error" role="alert">{entryMessage}</p>
			{/if}

			<div class="actions">
				<button class="button primary" disabled={reading} aria-busy={reading}>
					{reading ? 'Reading...' : 'Read and check'}
				</button>
				<span class="faint small">
					{#if data.entry.live.unlocked}
						Claude reads it; code checks the result.
					{:else}
						The rules extractor reads it; no AI is called.
					{/if}
				</span>
			</div>
		</form>

		<div class="body live-mode">
			{#if !data.entry.live.configured}
				<p class="faint small">
					Live reading is off on this server (no API key is set), so the rules extractor reads every request.
				</p>
			{:else if data.entry.live.unlocked}
				<form method="POST" action="?/lock" use:enhance class="inline">
					<Sparkles size={13} aria-hidden="true" />
					<span class="small muted">
						Live reading is on for you ({data.entry.live.model}). Each request read costs API credit.
					</span>
					<button class="button quiet">Turn off</button>
				</form>
			{:else}
				<form
					method="POST"
					action="?/unlock"
					class="inline"
					use:enhance={() => {
						unlocking = true;
						return async ({ update }) => {
							await update();
							unlocking = false;
						};
					}}
				>
					<Lock size={13} aria-hidden="true" />
					<label class="inline-label" for="passphrase">Live reading passphrase</label>
					<input id="passphrase" name="passphrase" type="password" autocomplete="off" required />
					<button class="button" disabled={unlocking}>Unlock for an hour</button>
				</form>
			{/if}
			{#if liveMessage}
				<p class="small" role="status">{liveMessage}</p>
			{/if}
		</div>
	</details>

	{#if checkMessage}
		<p class="notice" class:error={conflicted} role="status">{checkMessage}</p>
	{/if}

	<div class="segmented tabs" role="tablist" aria-label="Desk view">
		<button
			role="tab"
			aria-selected={tab === 'outbox'}
			aria-current={tab === 'outbox' ? 'true' : undefined}
			onclick={() => (tab = 'outbox')}
		>
			Outbox <span class="faint">{totals.queued + totals.approved}</span>
		</button>
		<button
			role="tab"
			aria-selected={tab === 'inbox'}
			aria-current={tab === 'inbox' ? 'true' : undefined}
			onclick={() => (tab = 'inbox')}
		>
			Inbox <span class="faint">{desk ? desk.messages : data.mailboxes.reduce((s, m) => s + m.messages, 0)}</span>
		</button>
	</div>

	{#if tab === 'outbox'}
		<section class="panel" aria-labelledby="queue">
			<header class="panel-head">
				<h2 id="queue">Waiting for you</h2>
				{#if totals.waiting > 0}<span class="chip warn">{totals.waiting} not worked yet</span>{/if}
			</header>
			{#await data.queue}
				<DeskListSkeleton rows={3} label="Loading the review queue" />
			{:then queue}
				{#if queue.length === 0}
					<p class="body muted">
						Nothing is waiting. Press "Check mail" and the agent will work whatever is in the inbox.
					</p>
				{:else}
					<ul class="drafts">
						{#each queue as draft (draft.id)}
							<li><DraftCard {draft} requestId={data.requestId} /></li>
						{/each}
					</ul>
				{/if}
			{:catch}
				<p class="body notice error" role="alert">
					The queue could not be loaded. Reload the page to try again.
				</p>
			{/await}
		</section>
	{:else}
		<section class="panel" aria-labelledby="inbox-list">
			<header class="panel-head">
				<h2 id="inbox-list">Inbox</h2>
				{#if totals.needsPerson > 0}<span class="chip warn">{totals.needsPerson} need a person</span>{/if}
			</header>
			{#await data.messages}
				<DeskListSkeleton rows={6} label="Loading the inbox" />
			{:then messages}
				{#if messages.length === 0}
					<p class="body muted">
						No mail yet. Press "Check mail" above.
					</p>
				{:else}
					<ul class="messages">
						{#each messages as message (message.id)}
							<li>
								<a href="/desk/{message.id}" class="row">
									<span class="who">
										<span class="name">{message.fromName || message.fromAddress}</span>
										<span class="mono faint small">{message.fromAddress}</span>
									</span>
									<span class="what">
										<span class="subject">{message.subject || '(no subject)'}</span>
										<span class="faint small">
											{message.customerName ??
												message.vendorName ??
												(message.matchReason ? 'Not matched to an account' : 'Not worked yet')}
											{#if message.attachments > 0}
												· {message.attachments} attached
											{/if}
										</span>
									</span>
									<span class="tags">
										{#if message.intent}
											<span class="chip">
												{INTENT_LABEL[message.intent]}
												{#if message.intentConfidence !== null}
													<span class="faint">{percent(message.intentConfidence)}</span>
												{/if}
											</span>
										{/if}
										<span class="chip state {message.status}">{MESSAGE_STATUS_LABEL[message.status]}</span>
									</span>
									<span class="faint small when">{moment(message.receivedAt)}</span>
								</a>
							</li>
						{/each}
					</ul>
				{/if}
			{:catch}
				<p class="body notice error" role="alert">
					The inbox could not be loaded. Reload the page to try again.
				</p>
			{/await}
		</section>
	{/if}
</main>

<style>
	.page {
		max-width: 1000px;
		margin: 0 auto;
		padding: var(--space-5) var(--space-4) var(--space-6);
		display: grid;
		gap: var(--space-3);
	}

	.head {
		display: grid;
		gap: 4px;
	}

	.head p {
		max-width: 76ch;
	}

	.banner {
		border-color: color-mix(in srgb, var(--focus) 35%, transparent);
	}

	.body {
		padding: var(--space-3);
	}

	.desks {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
	}

	.desk {
		flex: 1 1 300px;
		display: grid;
		gap: 3px;
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--hairline);
		border-radius: var(--radius);
		transition:
			background-color var(--speed) var(--ease),
			border-color var(--speed) var(--ease);
	}

	.desk:hover {
		background: var(--surface-hover);
	}

	.desk:active {
		background: var(--surface-press);
	}

	.desk.current {
		border-color: var(--hairline-strong);
		background: var(--surface-sunken);
	}

	.name {
		font-weight: 500;
	}

	.counts {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
	}

	.warn {
		color: var(--warning);
	}

	.small {
		font-size: 0.88rem;
	}

	.rules {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-3);
		border-top: 1px solid var(--hairline);
		background: var(--surface-sunken);
		border-radius: 0 0 var(--radius-lg) var(--radius-lg);
	}

	.rules form {
		margin: 0;
	}

	.rules p {
		flex: 1 1 320px;
		max-width: 80ch;
	}

	/* Hand entry: available, and not the first thing on the page. */
	.entry > summary {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		padding: 8px var(--space-3);
		cursor: pointer;
		border-radius: var(--radius-lg);
		transition: background-color var(--speed) var(--ease);
	}

	.entry > summary:hover {
		background: var(--surface-hover);
	}

	.entry > summary .name {
		font-weight: 500;
	}

	.intake {
		display: grid;
		gap: var(--space-3);
		border-top: 1px solid var(--hairline);
	}

	.row {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
	}

	.row label {
		flex: 1 1 200px;
	}

	.row label.wide {
		flex: 2 1 320px;
	}

	.file input {
		padding: 3px;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-3);
	}

	.live-mode {
		display: grid;
		gap: 6px;
		border-top: 1px solid var(--hairline);
		background: var(--surface-sunken);
		border-radius: 0 0 var(--radius-lg) var(--radius-lg);
	}

	.inline {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		margin: 0;
		color: var(--text-muted);
	}

	.inline-label {
		display: inline;
	}

	.inline input {
		height: var(--control-h);
		width: 200px;
	}

	.tabs {
		justify-self: start;
	}

	.drafts,
	.messages {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.drafts li + li,
	.messages li + li {
		border-top: 1px solid var(--hairline);
	}

	.row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		min-height: 48px;
		padding: 6px var(--space-3);
		transition: background-color var(--speed) var(--ease);
	}

	.row:hover {
		background: var(--surface-hover);
	}

	.row:active {
		background: var(--surface-press);
	}

	.who,
	.what {
		display: grid;
		min-width: 0;
	}

	.who {
		flex: 0 1 200px;
	}

	.what {
		flex: 1 1 260px;
	}

	.who > span,
	.what > span {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.subject {
		font-weight: 500;
	}

	.tags {
		flex: none;
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}

	.chip.state.needs_person {
		background: var(--warning-soft);
		color: var(--warning);
	}

	.chip.state.drafted {
		color: var(--status-delivering);
	}

	.when {
		flex: none;
		white-space: nowrap;
	}

	@media (max-width: 860px) {
		.page {
			padding: var(--space-3);
		}

		.when {
			display: none;
		}

		.row {
			flex-wrap: wrap;
		}

		.who {
			flex: 1 1 100%;
		}
	}
</style>
