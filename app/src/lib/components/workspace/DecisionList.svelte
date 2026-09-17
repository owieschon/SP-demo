<script lang="ts">
	// The workspace's own history: what was decided, by whom, when. It is kept
	// here rather than read back off the source rows, because the nightly job
	// rebuilds the world and a decision should outlive that.
	import { moment } from '$lib/format';
	import { DECISION_LABEL, SOURCE_HREF, SOURCE_LABEL, type QueueDecisionRow } from '$lib/workspace/types';

	let { decisions }: { decisions: QueueDecisionRow[] } = $props();
</script>

{#if decisions.length === 0}
	<p class="body muted">Nothing has been decided here yet.</p>
{:else}
	<table>
		<thead>
			<tr>
				<th scope="col">What</th>
				<th scope="col">Decision</th>
				<th scope="col">By</th>
				<th scope="col">When</th>
				<th scope="col">Note</th>
			</tr>
		</thead>
		<tbody>
			{#each decisions as decision (decision.id)}
				<tr>
					<td>
						<a class="link" href={SOURCE_HREF[decision.source](decision.sourceId)}>
							{SOURCE_LABEL[decision.source]} {decision.sourceId}
						</a>
					</td>
					<td>
						<span class="chip" class:warn={decision.decision === 'rejected'}>
							{DECISION_LABEL[decision.decision]}
						</span>
					</td>
					<td>{decision.decidedBy}</td>
					<td class="faint">{moment(decision.decidedAt)}</td>
					<td class="muted note">{decision.note}</td>
				</tr>
			{/each}
		</tbody>
	</table>
{/if}

<style>
	.body {
		padding: var(--space-3);
	}

	.note {
		max-width: 36ch;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
