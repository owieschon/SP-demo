<script lang="ts">
	/*
	  The one policy surface.

	  Every principal on one page: what they are responsible for, what they may
	  decide and up to what amount, and what they may be shown. Agents are in
	  the same list and edited with the same four forms, because they are rows
	  in the same three tables.

	  There is deliberately no page configurator here, and no column picker.
	  What a person sees is derived from these three things; if a screen is
	  wrong, the fix is a grant, not a layout.
	*/
	import { enhance } from '$app/forms';
	import Panel from '$lib/components/ui/Panel.svelte';
	import FormNotice from '$lib/components/ui/FormNotice.svelte';
	import SubmitButton from '$lib/components/ui/SubmitButton.svelte';
	import { money } from '$lib/format';
	import {
		AUTHORITIES,
		AUTHORITY_IS_AMOUNT,
		AUTHORITY_LABEL,
		AUTONOMY_LABEL,
		DISCLOSURE_LABEL,
		PRESETS,
		PRESET_LABEL,
		SCOPE_DIMENSIONS,
		SCOPE_LABEL,
		type Authority,
		type PrincipalPolicy,
		type ScopeDimension
	} from '$lib/roles/types';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const mayChange = $derived(data.list.mayChange);

	/** A distinct request id per form on the page, from the one the load made. */
	function reqId(kind: string, id: number, extra = ''): string {
		return `${data.requestId}-${kind}-${id}${extra ? `-${extra}` : ''}`;
	}

	/** "41 accounts" or "every account", from the counts the view carried. */
	function scopeWords(person: PrincipalPolicy): string {
		const counts = data.list.counts[person.id] ?? {};
		const parts: string[] = [];
		for (const dimension of SCOPE_DIMENSIONS) {
			const slice = counts[dimension];
			if (!slice) continue;
			const label = SCOPE_LABEL[dimension];
			parts.push(slice.all ? `every ${label.one}` : `${slice.count} ${label.one}${slice.count === 1 ? '' : 's'}`);
		}
		return parts.length ? parts.join(', ') : 'nothing yet';
	}

	/** What a grant's number means on screen. */
	function limitWords(authority: Authority, limit: number | null): string {
		if (authority === 'agent_autonomy') {
			return limit === null ? 'no level set' : `level ${limit}: ${AUTONOMY_LABEL[limit] ?? ''}`;
		}
		if (!AUTHORITY_IS_AMOUNT[authority]) return 'yes';
		return limit === null ? 'no ceiling' : `up to ${money(limit)}`;
	}

	/** Which authorities make sense to offer for this principal. */
	function offered(person: PrincipalPolicy): Authority[] {
		return AUTHORITIES.filter((a) =>
			person.kind === 'agent' ? a === 'agent_autonomy' : a !== 'agent_autonomy'
		);
	}

	const everyone = $derived([...data.list.people, ...data.list.agents]);
</script>

<svelte:head>
	<title>People · Northline</title>
</svelte:head>

<div class="page">
	<div class="page-head">
		<div class="titles">
			<h1>People</h1>
			<p class="muted prose">
				Who is responsible for what, what each of them may decide, and what they may be shown.
				Agents are in the same list: they hold scope, authority and disclosure in the same three
				tables a person does.
			</p>
		</div>
	</div>

	<FormNotice {form} />

	{#if !mayChange}
		<p class="t-meta muted">
			You can read all of this. Changing it needs the authority to change a policy.
		</p>
	{/if}

	<Panel title="Everybody" flush>
		<table>
			<caption class="sr-only">Every principal, with their scope, authority and disclosure</caption>
			<thead>
				<tr>
					<th scope="col">Who</th>
					<th scope="col">Responsible for</th>
					<th scope="col">Scope</th>
					<th scope="col">May decide</th>
					<th scope="col">May see</th>
				</tr>
			</thead>
			<tbody>
				{#each everyone as person (person.id)}
					<tr class:inactive={!person.active}>
						<th scope="row">
							<span class="who">{person.fullName}</span>
							<span class="t-meta muted">
								{person.kind === 'agent' ? 'Agent' : person.title} ·
								{PRESET_LABEL[person.preset]}
							</span>
						</th>
						<td class="muted">{person.responsibility}</td>
						<td class="muted">
							{scopeWords(person)}
							{#each person.scope as slice (slice.dimension)}
								{#if !slice.all}
									<a
										class="t-meta"
										href="?scope={person.id}:{slice.dimension}"
										aria-label="Show {person.fullName}'s {SCOPE_LABEL[slice.dimension].many}"
									>
										{SCOPE_LABEL[slice.dimension].many.toLowerCase()}
									</a>
								{/if}
							{/each}
						</td>
						<td>
							{#if person.authority.length === 0}
								<span class="muted">nothing yet</span>
							{:else}
								<ul class="grants">
									{#each person.authority as grant (grant.authority)}
										<li>
											{AUTHORITY_LABEL[grant.authority]}:
											<strong>{limitWords(grant.authority, grant.limit)}</strong>
											{#if grant.endsOn}<span class="t-meta muted">until {grant.endsOn}</span>{/if}
										</li>
									{/each}
								</ul>
							{/if}
							{#each person.authorityAhead as ahead (ahead.authority + ahead.startsOn)}
								<p class="t-meta ahead">
									From {ahead.startsOn}: {AUTHORITY_LABEL[ahead.authority]}
									{limitWords(ahead.authority, ahead.limit)}
								</p>
							{/each}
						</td>
						<td class="muted">{DISCLOSURE_LABEL[person.disclosure]}</td>
					</tr>

					{#if data.showing && data.showing.id === person.id}
						<tr>
							<td colspan="5" class="values">
								<strong>{SCOPE_LABEL[data.showing.dimension].many}</strong>
								<span class="t-meta muted">{data.values.length} of them</span>
								<p class="list">{data.values.join(', ')}</p>
								<a class="t-meta" href="?">Hide</a>
							</td>
						</tr>
					{/if}

					{#if mayChange}
						<tr>
							<td colspan="5" class="edit">
								<details>
									<summary>Change what {person.fullName} may do</summary>

									<div class="forms">
										<form method="POST" action="?/preset" use:enhance>
											<input type="hidden" name="userId" value={person.id} />
											<input type="hidden" name="requestId" value={reqId('preset', person.id)} />
											<label>
												<span>Preset</span>
												<select name="preset" value={person.preset}>
													{#each PRESETS as preset (preset)}
														<option value={preset}>{PRESET_LABEL[preset]}</option>
													{/each}
												</select>
											</label>
											<label class="wide">
												<span>Responsible for</span>
												<input
													name="responsibility"
													value={person.responsibility}
													maxlength="200"
													placeholder="One line"
												/>
											</label>
											<SubmitButton label="Save" tone="plain" />
										</form>

										<form method="POST" action="?/scope" use:enhance>
											<input type="hidden" name="userId" value={person.id} />
											<input type="hidden" name="requestId" value={reqId('scope', person.id)} />
											<label>
												<span>Scope</span>
												<select name="dimension">
													{#each SCOPE_DIMENSIONS as dimension (dimension)}
														<option value={dimension}>{SCOPE_LABEL[dimension].many}</option>
													{/each}
												</select>
											</label>
											<label class="wide">
												<span>Values, comma separated</span>
												<input name="values" placeholder="1235, 1474" />
											</label>
											<label class="tick">
												<input type="checkbox" name="all" />
												<span>Everything in it</span>
											</label>
											<SubmitButton label="Replace" tone="plain" />
										</form>

										<!--
											One form for a person's approval ceiling and for an agent's
											autonomy level. Same fields, same action, same table.
										-->
										<form method="POST" action="?/grant" use:enhance>
											<input type="hidden" name="userId" value={person.id} />
											<input type="hidden" name="requestId" value={reqId('grant', person.id)} />
											<label>
												<span>May decide</span>
												<select name="authority">
													{#each offered(person) as authority (authority)}
														<option value={authority}>{AUTHORITY_LABEL[authority]}</option>
													{/each}
												</select>
											</label>
											<label>
												<span>{person.kind === 'agent' ? 'Level 0 to 3' : 'Up to'}</span>
												<input name="limit" inputmode="decimal" placeholder="no ceiling" />
											</label>
											<label>
												<span>From</span>
												<input name="startsOn" type="date" />
											</label>
											<label class="wide">
												<span>Why</span>
												<input name="note" maxlength="300" placeholder="Covering next week" />
											</label>
											<SubmitButton label="Grant" />
										</form>

										<form method="POST" action="?/revoke" use:enhance>
											<input type="hidden" name="userId" value={person.id} />
											<input type="hidden" name="requestId" value={reqId('revoke', person.id)} />
											<label>
												<span>Take away</span>
												<select name="authority">
													{#each person.authority as grant (grant.authority)}
														<option value={grant.authority}>
															{AUTHORITY_LABEL[grant.authority]}
														</option>
													{/each}
												</select>
											</label>
											<SubmitButton
												label="Revoke"
												tone="danger"
												disabled={person.authority.length === 0}
											/>
										</form>

										<form method="POST" action="?/disclosure" use:enhance>
											<input type="hidden" name="userId" value={person.id} />
											<input type="hidden" name="requestId" value={reqId('disclosure', person.id)} />
											<label class="wide">
												<span>May see</span>
												<select name="level" value={person.disclosure}>
													<option value="customer">{DISCLOSURE_LABEL.customer}</option>
													<option value="vendor">{DISCLOSURE_LABEL.vendor}</option>
													<option value="internal">{DISCLOSURE_LABEL.internal}</option>
												</select>
											</label>
											<SubmitButton label="Save" tone="plain" />
										</form>
									</div>
								</details>
							</td>
						</tr>
					{/if}
				{/each}
			</tbody>
		</table>
	</Panel>

	<Panel title="How this is resolved">
		<p class="prose">
			A preset is a name, not a rule. Nothing in the app asks "is this person a buyer": it asks
			whether the thing in front of them is in their scope, and whether they hold the authority the
			decision needs. So moving somebody between presets changes nothing on its own, and a grant
			takes effect in the same transaction it is written in.
		</p>
		<p class="prose muted">
			Approval limits come from <strong
				>{data.list.policyEngine ? 'the policy engine' : 'the grants in this table'}</strong
			>. Column purposes come from <strong>{data.list.columnSource}</strong>. Every change on this
			page leaves a row in the audit log naming who made it.
		</p>
	</Panel>
</div>

<style>
	.who {
		display: block;
		font-weight: 500;
	}

	.t-meta {
		display: inline-block;
	}

	tr.inactive th,
	tr.inactive td {
		opacity: 0.6;
	}

	.grants {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.ahead {
		margin: 4px 0 0;
		color: var(--text-muted);
	}

	.values .list {
		margin: 4px 0;
		word-break: break-word;
	}

	.edit details {
		padding: 2px 0;
	}

	.edit summary {
		cursor: pointer;
		color: var(--text-muted);
		font-size: var(--fs-meta);
	}

	.forms {
		display: grid;
		gap: var(--space-3);
		padding: var(--space-3) 0;
	}

	.forms form {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: var(--space-2);
		margin: 0;
		padding-bottom: var(--space-3);
		border-bottom: 1px solid var(--hairline);
	}

	.forms form:last-child {
		border-bottom: 0;
		padding-bottom: 0;
	}

	.forms label {
		display: grid;
		gap: 2px;
		font-size: var(--fs-meta);
		color: var(--text-muted);
	}

	.forms label.wide {
		flex: 1 1 220px;
	}

	.forms label.tick {
		display: flex;
		align-items: center;
		gap: 6px;
	}
</style>
