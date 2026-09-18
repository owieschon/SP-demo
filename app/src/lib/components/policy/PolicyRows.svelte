<script lang="ts">
	// Every policy row set for one policy: where it applies, what it says, the
	// window it applies in, who set it and why.
	//
	// Nothing is ever deleted here. Ending a policy sets its last day, which
	// leaves the trace able to explain a figure from before today. That is why
	// the only destructive-looking button says "End it" and not "Delete".
	import { enhance } from '$app/forms';
	import { day, moment } from '$lib/format';
	import { SCOPE_LABEL, type PolicyRow, type PolicyType } from '$lib/policy/types';
	import { freshRequestId } from './ids.ts';

	let {
		type,
		rows,
		canEdit,
		requestId,
		today,
		year
	}: {
		type: PolicyType;
		rows: PolicyRow[];
		canEdit: boolean;
		requestId: string;
		today: string;
		year: number;
	} = $props();

	const STATUS_WORDS: Record<PolicyRow['status'], string> = {
		in_force: 'in force',
		upcoming: 'upcoming',
		expired: 'expired'
	};
</script>

{#if rows.length === 0}
	<p class="empty">
		Nothing is set for this policy, so every answer is the built-in default,
		{type.defaultWords}.
	</p>
{:else}
	<div class="table-wrap" tabindex="-1">
		<table>
			<thead>
				<tr>
					<th scope="col">Applies to</th>
					<th scope="col">Value</th>
					<th scope="col">In force</th>
					<th scope="col" class="num">Priority</th>
					<th scope="col">Why</th>
					<th scope="col">Set by</th>
					{#if canEdit}
						<th scope="col"><span class="sr-only">Actions</span></th>
					{/if}
				</tr>
			</thead>
			<tbody>
				{#each rows as row (row.id)}
					<tr>
						<th scope="row">
							<span>{SCOPE_LABEL[row.scopeKind]}</span>
							{#if row.scopeId !== ''}
								<span class="faint">{row.scopeLabel}</span>
							{/if}
						</th>
						<td><strong>{row.valueWords}</strong></td>
						<td class="nowrap">
							{day(row.effectiveFrom, year)}
							{row.effectiveTo === null ? 'onwards' : `to ${day(row.effectiveTo, year)}`}
							<span class="chip" class:warn={row.status === 'expired'}>{STATUS_WORDS[row.status]}</span>
						</td>
						<td class="num faint">{row.priority}</td>
						<td class="why">{row.note === '' ? '·' : row.note}</td>
						<td class="faint nowrap">
							{row.setByName ?? 'the seed'}
							<span class="faint">{moment(row.updatedAt)}</span>
						</td>
						{#if canEdit}
							<td class="actions">
								<a class="button quiet sm" href="?type={type.key}&edit={row.id}">Change</a>
								{#if row.status !== 'expired'}
									<form
										method="POST"
										action="?/end"
										use:enhance={({ formData }) => {
											formData.set('requestId', freshRequestId());
											return async ({ update }) => await update({ reset: false });
										}}
									>
										<input type="hidden" name="policyId" value={row.id} />
										<input type="hidden" name="expectedUpdatedAt" value={row.updatedAt} />
										<input type="hidden" name="effectiveTo" value={today} />
										<input type="hidden" name="requestId" value={requestId} />
										<button class="button quiet sm" type="submit">End it</button>
									</form>
								{/if}
							</td>
						{/if}
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}

<style>
	th[scope='row'] {
		display: grid;
		gap: 1px;
		font-weight: 500;
		color: var(--text);
		border-bottom: 1px solid var(--hairline);
		white-space: normal;
		max-width: 26ch;
	}

	.why {
		max-width: 40ch;
		white-space: normal;
		font-size: var(--fs-meta);
	}

	.nowrap {
		white-space: nowrap;
	}

	td.faint {
		display: grid;
		gap: 1px;
		font-size: var(--fs-meta);
	}

	.actions {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.actions form {
		display: contents;
	}
</style>
