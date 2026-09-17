<script lang="ts">
	// The rule builder: WHEN something happens, IF these conditions hold,
	// THEN add a next step or a note. Built for people who do not write code.
	//
	// The whole rule lives here as Svelte state while it is being built, and
	// is read back as one plain-English sentence as it changes. The buttons
	// send it to the server as a single JSON field; the server checks it with
	// the same catalog (ruleSchema) before it tests or saves anything.
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { untrack } from 'svelte';
	import CalendarX from '@lucide/svelte/icons/calendar-x';
	import FlaskConical from '@lucide/svelte/icons/flask-conical';
	import Gauge from '@lucide/svelte/icons/gauge';
	import ListTodo from '@lucide/svelte/icons/list-todo';
	import MessageSquareText from '@lucide/svelte/icons/message-square-text';
	import Moon from '@lucide/svelte/icons/moon';
	import PackageX from '@lucide/svelte/icons/package-x';
	import TruckElectric from '@lucide/svelte/icons/truck-electric';
	import Plus from '@lucide/svelte/icons/plus';
	import {
		ACTION_LABELS,
		allowedPlaceholders,
		MAX_CONDITIONS,
		ruleSchema,
		TRIGGER_KEYS,
		TRIGGERS,
		type Rule,
		type TriggerKey
	} from '$lib/automation/catalog';
	import { describeRule, friendlyIssues, placeholderLabel } from '$lib/automation/describe';
	import type { EditorAnswer, PersonOption } from '$lib/automation/types';
	import ConditionRow from './ConditionRow.svelte';
	import TemplateField from './TemplateField.svelte';
	import TestResults from './TestResults.svelte';
	import { blankRow, fromCondition, rowIssue, rowsForTrigger, toCondition } from './editor';

	let {
		initial,
		ruleId,
		updatedAt,
		requestId,
		canEdit,
		ownerName,
		people,
		answer
	}: {
		/** The rule as loaded (or the starter rule). Edits never change it. */
		initial: Rule;
		ruleId: number | null;
		/** Row version of the saved rule, sent back on save. */
		updatedAt: string | null;
		requestId: string;
		canEdit: boolean;
		ownerName: string;
		people: PersonOption[];
		/** The last answer from a form action on this page. */
		answer: EditorAnswer | null;
	} = $props();

	const TRIGGER_ICONS = {
		window_closed_short: CalendarX,
		commitment_behind_pace: Gauge,
		account_gone_quiet: Moon,
		order_line_at_risk: PackageX,
		order_line_projected_late: TruckElectric
	};
	const KINDS = [
		{ value: 'next_step', icon: ListTodo },
		{ value: 'note', icon: MessageSquareText }
	] as const;

	// ---- The rule being built ------------------------------------------
	// `initial` is only the starting point: edits stay here, in this
	// component's own state. untrack says so on purpose (reading a prop once
	// is otherwise a warning). The page wraps this component in {#key}, so a
	// newly loaded version of the rule starts a fresh editor.
	const start = untrack(() => $state.snapshot(initial));
	let name = $state(start.name);
	let description = $state(start.description);
	let enabled = $state(start.enabled);
	let trigger = $state<TriggerKey>(start.trigger);
	let rows = $state(start.conditions.map(fromCondition));
	let kind = $state(start.action.kind);
	let title = $state(start.action.kind === 'next_step' ? start.action.title : 'Follow up with {customer}');
	let body = $state(start.action.kind === 'note' ? start.action.body : 'Automation: {headline}');
	let dueInDays = $state<number | null>(start.action.kind === 'next_step' ? start.action.dueInDays : 2);
	let assignTo = $state(start.action.kind === 'next_step' ? start.action.assignTo : 'record_owner');

	/** The state above, in the shape the catalog checks. */
	const rule: Rule = $derived({
		name,
		description,
		trigger,
		enabled,
		conditions: rows.map((row) => toCondition(trigger, row)),
		action:
			kind === 'next_step'
				? { kind, title, dueInDays: dueInDays ?? Number.NaN, assignTo }
				: { kind, body }
	});
	const ruleJson = $derived(JSON.stringify(rule));

	const names = $derived(new Map(people.map((p) => [p.id, p.name])));
	const sentence = $derived(describeRule(rule, (id) => names.get(id) ?? `user ${id}`, ownerName));
	const placeholders = $derived(
		allowedPlaceholders(trigger).map((p) => ({ name: p, label: placeholderLabel(trigger, p) }))
	);

	function pickTrigger(key: TriggerKey) {
		if (key === trigger) return;
		// Keep only the conditions the new trigger understands.
		rows = rowsForTrigger(trigger, key, rows);
		trigger = key;
	}

	function addRow() {
		rows.push(blankRow(trigger));
	}

	function removeRow(key: number) {
		rows = rows.filter((row) => row.key !== key);
	}

	// ---- Problems ---------------------------------------------------------
	// Shown once the person has pressed a button. The check is the catalog's
	// own ruleSchema, the same one the server runs, so what shows here is
	// what the server would say; it just updates as they fix things.
	let attempted = $state(false);
	const check = $derived(ruleSchema.safeParse(rule));
	const issues: Record<string, string> = $derived.by(() => {
		if (!attempted) return answer?.issues ?? {};
		return check.success ? {} : friendlyIssues(check.error.issues);
	});
	const issueCount = $derived(Object.keys(issues).length);

	// ---- Sending ------------------------------------------------------------
	let pending = $state<'test' | 'save' | null>(null);
	// The rule as it was when last tested: to say when the results are out of
	// date, and to label their columns by the trigger that was tested.
	let tested = $state<{ json: string; trigger: TriggerKey; kind: Rule['action']['kind'] } | null>(null);

	const submit: SubmitFunction = ({ submitter }) => {
		attempted = true;
		pending = submitter?.getAttribute('formaction') === '?/save' ? 'save' : 'test';
		if (pending === 'test') tested = { json: ruleJson, trigger, kind };
		return async ({ update }) => {
			// reset: false keeps what is on screen; the page data still refreshes.
			await update({ reset: false });
			pending = null;
		};
	};

	const test = $derived(answer?.from === 'test' ? (answer.test ?? null) : null);
	// "Run now" answers show in the activity panel instead.
	const notice = $derived(answer && answer.from !== 'run' && answer.message ? answer : null);
	const testIsStale = $derived(test !== null && tested !== null && tested.json !== ruleJson);
</script>

<form method="POST" action="?/test" class="editor" use:enhance={submit} novalidate>
	<!-- What the server reads. Outside the fieldset, so a read-only view still sends them for a test. -->
	<input type="hidden" name="rule" value={ruleJson} />
	<input type="hidden" name="ruleId" value={ruleId ?? ''} />
	<input type="hidden" name="expectedUpdatedAt" value={updatedAt ?? ''} />
	<input type="hidden" name="requestId" value={requestId} />

	<section class="panel sentence" aria-label="The rule in plain English">
		<span class="eyebrow">This rule reads</span>
		<p>{sentence}</p>
	</section>

	{#if !canEdit}
		<p class="notice warning">
			Only {ownerName} or an admin can change or run this rule. You can still test it.
		</p>
	{/if}

	{#if notice}
		<p class="notice" class:error={notice.failed} role={notice.failed ? 'alert' : 'status'}>
			<span>{notice.message}</span>
			{#if notice.conflict}
				<!-- The page shows a fresh editor once the newer version arrives. -->
				<button type="button" class="button" onclick={() => invalidateAll()}>Load the latest version</button>
			{/if}
		</p>
	{/if}

	<fieldset class="plain" disabled={!canEdit}>
		<section class="panel" aria-labelledby="about-title">
			<header class="panel-head">
				<h2 id="about-title">Name</h2>
				<label class="switch">
					<input type="checkbox" role="switch" bind:checked={enabled} />
					<span class="track" aria-hidden="true"></span>
					<span>{enabled ? 'On: runs every morning' : 'Off'}</span>
				</label>
			</header>
			<div class="body two">
				<label>
					<span>Name</span>
					<input
						bind:value={name}
						maxlength="80"
						placeholder="Chase closed-short windows"
						aria-invalid={issues.name ? 'true' : undefined}
					/>
					{#if issues.name}<span class="field-error">{issues.name}</span>{/if}
				</label>
				<label>
					<span>Why it exists <span class="faint">(optional)</span></span>
					<input bind:value={description} maxlength="300" placeholder="So nobody forgets to ask what happened." />
				</label>
			</div>
		</section>

		<section class="panel step" aria-labelledby="when-title">
			<header class="panel-head">
				<h2 id="when-title"><span class="step-no">1</span> When</h2>
				<span class="faint">What should it watch for?</span>
			</header>
			<div class="body cards" role="radiogroup" aria-labelledby="when-title">
				{#each TRIGGER_KEYS as key (key)}
					{@const Icon = TRIGGER_ICONS[key]}
					<label class="card pressable" class:selected={trigger === key}>
						<input
							class="sr-only"
							type="radio"
							name="trigger-choice"
							value={key}
							checked={trigger === key}
							onchange={() => pickTrigger(key)}
						/>
						<span class="card-title">
							<Icon size={15} strokeWidth={1.75} aria-hidden="true" />
							{TRIGGERS[key].label}
						</span>
						<span class="card-text">{TRIGGERS[key].description}</span>
					</label>
				{/each}
			</div>
		</section>

		<section class="panel step" aria-labelledby="if-title">
			<header class="panel-head">
				<h2 id="if-title"><span class="step-no">2</span> If</h2>
				<span class="faint">
					{rows.length === 0 ? 'No conditions: every match counts.' : 'All of these must be true.'}
				</span>
			</header>
			<div class="conditions">
				{#each rows as row, index (row.key)}
					<ConditionRow
						bind:row={rows[index]}
						{trigger}
						{people}
						{index}
						disabled={!canEdit}
						error={rowIssue(issues, index)}
						onremove={() => removeRow(row.key)}
					/>
				{/each}
			</div>
			<footer class="add">
				<button type="button" class="button quiet" onclick={addRow} disabled={rows.length >= MAX_CONDITIONS}>
					<Plus size={14} strokeWidth={1.75} aria-hidden="true" />
					Add a condition
				</button>
				{#if rows.length >= MAX_CONDITIONS}
					<span class="faint">Up to {MAX_CONDITIONS}.</span>
				{/if}
				{#if issues.conditions}<span class="field-error">{issues.conditions}</span>{/if}
			</footer>
		</section>

		<section class="panel step" aria-labelledby="then-title">
			<header class="panel-head">
				<h2 id="then-title"><span class="step-no">3</span> Then</h2>
				<span class="faint">It only ever adds; it never changes or removes anything.</span>
			</header>
			<div class="body then">
				<div class="kinds" role="radiogroup" aria-label="What to do">
					{#each KINDS as choice (choice.value)}
						<label class="kind pressable" class:selected={kind === choice.value}>
							<input class="sr-only" type="radio" name="kind-choice" value={choice.value} bind:group={kind} />
							<choice.icon size={15} strokeWidth={1.75} aria-hidden="true" />
							{ACTION_LABELS[choice.value]}
						</label>
					{/each}
				</div>

				{#if kind === 'next_step'}
					<TemplateField
						bind:value={title}
						label="Next step"
						hint="What should someone do?"
						{placeholders}
						maxlength={200}
						disabled={!canEdit}
						error={issues['action.title'] ?? issues.action ?? null}
					/>
					<div class="row">
						<label class="due">
							<span>Due in</span>
							<span class="inline">
								<input type="number" min="0" max="60" step="1" inputmode="numeric" bind:value={dueInDays} />
								<span class="faint">days</span>
							</span>
							{#if issues['action.dueInDays']}<span class="field-error">{issues['action.dueInDays']}</span>{/if}
						</label>
						<div class="assign">
							<span class="label-text" id="assign-label">Give it to</span>
							<div class="segmented" role="radiogroup" aria-labelledby="assign-label">
								<label class:on={assignTo === 'record_owner'}>
									<input class="sr-only" type="radio" name="assign-choice" value="record_owner" bind:group={assignTo} />
									Whoever owns the record
								</label>
								<label class:on={assignTo === 'rule_owner'}>
									<input class="sr-only" type="radio" name="assign-choice" value="rule_owner" bind:group={assignTo} />
									The rule's owner
								</label>
							</div>
							<span class="faint small">When the record has no active owner, it goes to the rule's owner.</span>
						</div>
					</div>
				{:else}
					<TemplateField
						bind:value={body}
						label="Note"
						hint="Added to the account's history, marked as written by an automation."
						{placeholders}
						maxlength={500}
						rows={3}
						disabled={!canEdit}
						error={issues['action.body'] ?? issues.action ?? null}
					/>
				{/if}
			</div>
		</section>
	</fieldset>

	<div class="bar">
		<span class="faint status" role="status">
			{#if issueCount > 0}
				<span class="bad">{issueCount === 1 ? 'One thing needs' : `${issueCount} things need`} fixing above.</span>
			{:else if ruleId === null}
				Test it as often as you like; nothing is written until you save.
			{:else}
				Testing never writes anything.
			{/if}
		</span>
		<button class="button" formaction="?/test" disabled={pending !== null} aria-busy={pending === 'test'}>
			<FlaskConical size={14} strokeWidth={1.75} aria-hidden="true" />
			{pending === 'test' ? 'Testing' : 'Test this rule'}
		</button>
		{#if canEdit}
			<button class="button primary" formaction="?/save" disabled={pending !== null} aria-busy={pending === 'save'}>
				{pending === 'save' ? 'Saving' : ruleId === null ? 'Save rule' : 'Save changes'}
			</button>
		{/if}
	</div>
</form>

{#if pending === 'test'}
	<div class="panel test-skeleton" aria-hidden="true">
		{#each [0, 1, 2, 3] as i (i)}
			<div class="skeleton-row">
				<span class="skeleton" style:width="{30 - i * 3}%" style:height="11px"></span>
				<span class="skeleton" style:width="12%" style:height="11px"></span>
				<span class="skeleton" style:width="35%" style:height="11px"></span>
			</div>
		{/each}
	</div>
{:else if test}
	{#if testIsStale}
		<p class="faint stale">The rule has changed since this test. Test it again to see the new matches.</p>
	{/if}
	<div class:stale-results={testIsStale}>
		<TestResults result={test} trigger={tested?.trigger ?? trigger} kind={tested?.kind ?? kind} />
	</div>
{/if}

<style>
	.editor {
		display: grid;
		gap: var(--space-3);
	}

	/* The fieldset only switches everything off for read-only viewers. */
	.plain {
		display: grid;
		gap: var(--space-3);
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}

	.body {
		padding: var(--space-3);
	}

	.two {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
	}

	.two > label {
		flex: 1 1 260px;
	}

	.sentence {
		display: grid;
		gap: 4px;
		padding: 10px var(--space-3);
		background: var(--surface-sunken);
	}

	.sentence p {
		font-size: 1.05rem;
		line-height: 1.5;
		overflow-wrap: anywhere;
	}

	.step-no {
		display: inline-grid;
		place-items: center;
		width: 18px;
		height: 18px;
		margin-right: 4px;
		border-radius: 50%;
		background: var(--surface-sunken);
		box-shadow: inset 0 0 0 1px var(--hairline-strong);
		font-size: 0.75rem;
		font-variant-numeric: tabular-nums;
	}

	.panel-head {
		flex-wrap: wrap;
	}

	/* On/off switch */
	.switch {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		color: var(--text);
		cursor: pointer;
	}

	.switch input {
		position: absolute;
		opacity: 0;
		width: 1px;
		height: 1px;
	}

	.track {
		position: relative;
		width: 30px;
		height: 18px;
		border-radius: 9px;
		background: var(--hairline-strong);
		transition: background-color var(--speed) var(--ease);
	}

	.track::after {
		content: '';
		position: absolute;
		top: 2px;
		left: 2px;
		width: 14px;
		height: 14px;
		border-radius: 50%;
		background: var(--surface);
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.2);
		transition: transform var(--speed) var(--ease);
	}

	.switch input:checked + .track {
		background: var(--status-kept);
	}

	.switch input:checked + .track::after {
		transform: translateX(12px);
	}

	.switch input:focus-visible + .track {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}

	/* Trigger and action choices: cards with a real radio button inside. */
	.cards {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.card {
		flex: 1 1 220px;
		display: grid;
		align-content: start;
		gap: 4px;
		padding: 10px 12px;
		border: 1px solid var(--hairline-strong);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		cursor: pointer;
		-webkit-tap-highlight-color: transparent;
		transition:
			background-color var(--speed) var(--ease),
			border-color var(--speed) var(--ease),
			box-shadow var(--speed) var(--ease),
			transform var(--speed) var(--ease);
	}

	.card:hover,
	.kind:hover {
		background: var(--surface-hover);
	}

	.card.selected,
	.kind.selected {
		border-color: var(--text);
		box-shadow: inset 0 0 0 1px var(--text);
	}

	.card:focus-within,
	.kind:focus-within {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}

	.card-title {
		display: flex;
		align-items: center;
		gap: 6px;
		font-weight: 500;
	}

	.card-text {
		color: var(--text-muted);
		font-size: 0.88rem;
	}

	.conditions:empty {
		display: none;
	}

	.add {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		padding: 6px var(--space-2);
		border-top: 1px solid var(--hairline);
	}

	.then {
		display: grid;
		gap: var(--space-3);
	}

	.kinds {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.kind {
		flex: 0 1 auto;
		display: flex;
		flex-direction: row;
		align-items: center;
		gap: 6px;
		height: 32px;
		padding: 0 12px;
		border: 1px solid var(--hairline-strong);
		border-radius: var(--radius);
		color: var(--text);
		font-weight: 500;
		cursor: pointer;
		-webkit-tap-highlight-color: transparent;
		transition:
			background-color var(--speed) var(--ease),
			border-color var(--speed) var(--ease),
			transform var(--speed) var(--ease);
	}

	.row {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3) var(--space-5);
		align-items: flex-start;
	}

	.inline {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.due input {
		width: 70px;
		height: var(--control-h);
	}

	.assign {
		display: grid;
		gap: var(--space-1);
		font-size: 0.92rem;
	}

	.label-text {
		color: var(--text-muted);
	}

	.segmented label {
		display: inline-flex;
		color: inherit;
		font-size: inherit;
	}

	/* The chosen option looks like the app's other pressed segments. */
	.segmented > label.on {
		background: var(--surface);
		color: var(--text);
		box-shadow:
			0 0 0 1px var(--hairline-strong),
			0 1px 2px rgb(0 0 0 / 0.05);
	}

	.segmented label:focus-within {
		outline: 2px solid var(--focus);
		outline-offset: 1px;
	}

	.small {
		font-size: 0.85rem;
	}

	.field-error,
	.bad {
		color: var(--danger);
		font-size: 0.88rem;
	}

	input[aria-invalid='true'] {
		border-color: var(--danger);
	}

	/* The buttons stay in reach at the bottom of the screen while scrolling. */
	.bar {
		position: sticky;
		bottom: 0;
		z-index: 2;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: flex-end;
		gap: var(--space-2);
		padding: 10px var(--space-3);
		border: 1px solid var(--hairline);
		border-radius: var(--radius-lg);
		background: color-mix(in srgb, var(--surface) 92%, transparent);
		backdrop-filter: blur(8px);
		-webkit-backdrop-filter: blur(8px);
		box-shadow: var(--overlay-shadow);
	}

	.status {
		flex: 1 1 200px;
	}

	.test-skeleton {
		opacity: 0.8;
	}

	.skeleton-row {
		display: flex;
		justify-content: space-between;
		gap: var(--space-3);
		align-items: center;
		height: 34px;
		padding: 0 var(--space-3);
	}

	.skeleton-row + .skeleton-row {
		border-top: 1px solid var(--hairline);
	}

	.stale {
		font-size: 0.92rem;
	}

	.stale-results {
		opacity: 0.6;
		transition: opacity var(--speed) var(--ease);
	}

	@media (max-width: 720px) {
		/* 16px text stops phones from zooming into a focused box. */
		input {
			font-size: 16px;
		}

		.bar .button {
			flex: 1 1 auto;
			height: 36px;
		}

		.segmented {
			flex-wrap: wrap;
		}
	}
</style>
