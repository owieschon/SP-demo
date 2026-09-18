// Scripted demo mode: a model made of if-statements.
//
// Why it exists: the page is public, so anyone can try the feature, and the
// owner's API credit is not public. The scripted model answers a handful of
// question shapes from the real database through the real tools, and it runs
// inside the same loop as the real model, so the gate, the proposal, the caps
// and the audit trail are all the real ones. Only the choice of which tool to
// ask for next is scripted.
//
// It is never called Claude in the interface. The badge says "scripted demo
// mode" and the answers say where the numbers came from.
import type { Rule } from '$lib/automation/catalog';
import type { AskModel, ModelReply, ModelTurn } from './loop.ts';
import { unwrapToolResult } from './wrap.ts';

export const MOCK_LABEL = 'scripted demo mode';

/** One finished tool call, as the scripted model reads it back. */
interface Seen {
	name: string;
	payload: Record<string, unknown>;
}

function rowsOf(payload: Record<string, unknown> | undefined): Record<string, unknown>[] {
	const rows = payload?.rows;
	return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

function object(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function text(value: unknown, fallback = ''): string {
	return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function num(value: unknown): number {
	return typeof value === 'number' ? value : 0;
}

const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/** What has happened since the last question, in order. */
function seenSinceQuestion(history: ModelTurn[]): { question: string; seen: Seen[] } {
	let from = -1;
	for (let i = history.length - 1; i >= 0; i--) {
		if (history[i].kind === 'question') {
			from = i;
			break;
		}
	}
	const question = from >= 0 ? history[from].text : '';
	const seen: Seen[] = [];
	for (const turn of history.slice(from + 1)) {
		for (const result of turn.toolResults ?? []) {
			seen.push({ name: result.name, payload: object(unwrapToolResult(result.text)) });
		}
	}
	return { question, seen };
}

function answer(body: string): ModelReply {
	return { text: body, toolCalls: [], usage: null, stopReason: 'end_turn' };
}

function ask(name: string, input: unknown, round: number): ModelReply {
	return {
		text: '',
		toolCalls: [{ id: `demo_${round}_${name}`, name, input }],
		usage: null,
		stopReason: 'tool_use'
	};
}

type Shape = 'automation' | 'closed_short' | 'part' | 'quiet' | 'help';

/** Which of the scripted shapes a question is. The order matters. */
export function shapeOf(question: string): Shape {
	const q = question.toLowerCase();
	if (/remind|automat|\brule\b|every night|nightly|whenever/.test(q)) return 'automation';
	if (/closed short|fell short|window|outcome|pushed|kept|broken|commitment/.test(q)) return 'closed_short';
	if (/stock|on hand|inventory|\bpart\b|item |shelf|reorder/.test(q)) return 'part';
	if (/quiet|stopped ordering|has not ordered|hasn't ordered|lapsed|gone dark/.test(q)) return 'quiet';
	return 'help';
}

/** A part number as the catalog writes them: L3515-630SC, CU-41545. */
function itemNoIn(question: string): string | null {
	const match = question.match(/\b[A-Za-z]{1,3}[0-9]{0,5}-[A-Za-z0-9-]{2,20}\b/);
	return match ? match[0].toUpperCase() : null;
}

/** The rule the automation shape proposes. Written out so it reads plainly. */
function quietRule(): Rule {
	return {
		name: 'Quiet account follow-up',
		description: 'Adds a next step when an account has not ordered for twice its own usual gap.',
		trigger: 'account_gone_quiet',
		conditions: [
			{ field: 'quiet_ratio', op: 'gte', value: 2 },
			{ field: 'days_quiet', op: 'gte', value: 21 }
		],
		action: {
			kind: 'next_step',
			title: 'Call {customer}: no order in {days_quiet} days, usual gap is {typical_gap_days}',
			dueInDays: 3,
			assignTo: 'record_owner'
		},
		enabled: true
	};
}

/**
 * The scripted model. It is given the id of the person asking so it can say
 * "mine" in the queries it writes, exactly as the real model would by reading
 * the system prompt.
 */
export function mockModel(options: { userId: number }): AskModel {
	return {
		mode: 'mock',
		label: MOCK_LABEL,
		model: 'scripted-demo',
		async next(history) {
			const { question, seen } = seenSinceQuestion(history);
			const step = seen.length;
			const round = step + 1;
			const shape = shapeOf(question);

			if (shape === 'closed_short') {
				if (step === 0) return ask('list_windows_closed_short', { whose: 'me', limit: 5 }, round);

				const list = seen.find((s) => s.name === 'list_windows_closed_short')?.payload;
				const first = rowsOf(list)[0];
				if (!first) {
					return answer(
						'None of your commitment windows has closed short with the question still open. The board reads that from the invoice ledger, so it is up to date as of today.'
					);
				}

				if (step === 1) return ask('get_commitment', { commitment_id: num(first.id) }, round);

				// Round three asks for the gated tool on purpose, so the demo
				// shows the gate refusing it rather than only talking about it.
				if (step === 2) {
					return ask(
						'record_outcome',
						{ commitment_id: num(first.id), outcome: 'pushed', note: 'Window closed short; asked the buyer.' },
						round
					);
				}

				if (step === 3) {
					return ask(
						'propose_action',
						{
							summary: `C-${num(first.id)} at ${text(first.customer_name, 'this account')} closed ${num(first.days_since_close)} days ago with ${dollars.format(num(first.delivered))} of ${dollars.format(num(first.committed_value))} delivered. Say what happened.`,
							options: [
								{
									label: 'The business moved out of the window',
									tool: 'record_outcome',
									input: {
										commitment_id: num(first.id),
										outcome: 'pushed',
										note: 'Still coming, outside this window.'
									}
								},
								{
									label: 'They did not buy it',
									tool: 'record_outcome',
									input: { commitment_id: num(first.id), outcome: 'broken', note: 'Not going ahead.' }
								}
							]
						},
						round
					);
				}

				const detail = object(seen.find((s) => s.name === 'get_commitment')?.payload.commitment);
				const delivered = num(detail.delivered || first.delivered);
				const committed = num(detail.committed_value || first.committed_value);
				const share = committed > 0 ? Math.round((delivered / committed) * 100) : 0;
				return answer(
					[
						`${text(detail.title, text(first.title, 'That commitment'))} (C-${num(first.id)}) at ${text(detail.customer_name, text(first.customer_name, 'the account'))} closed ${num(first.days_since_close)} days ago.`,
						`${dollars.format(delivered)} of ${dollars.format(committed)} arrived, which is ${share}%, measured from the invoice lines for its parts inside the window.`,
						`Recording the answer is not something I can do on my own: the two options are above, and nothing runs until you approve one.`
					].join(' ')
				);
			}

			if (shape === 'quiet') {
				if (step === 0) {
					// The only value put into this query's text is the signed-in
					// person's own id, which is an integer from the session, never
					// anything typed. Everything else is fixed text.
					const me = Number.isSafeInteger(options.userId) ? options.userId : 0;
					return ask(
						'run_sql',
						{
							why: 'Accounts of mine that have not ordered for twice their own usual gap',
							sql: `select c.customer_no, c.name, c.city, c.state, a.days_quiet, a.typical_gap_days,
							             round(a.quiet_ratio, 1) as quiet_ratio, a.last_order_on
							      from nl.account_cadence a
							      join nl.customers c on c.customer_no = a.customer_no
							      where a.quiet_ratio >= 2 and a.days_quiet >= 21
							        and c.owner_id = ${me} and not c.closed
							      order by a.days_quiet desc
							      limit 5`
						},
						round
					);
				}

				const found = rowsOf(seen.find((s) => s.name === 'run_sql')?.payload);
				if (found.length === 0) {
					return answer(
						'None of your accounts is quiet by its own standard right now. The measure is days since the last order against that account\'s own typical gap, not a fixed number of days.'
					);
				}
				if (step === 1) return ask('get_account', { customer_no: text(found[0].customer_no) }, round);

				const account = object(seen.find((s) => s.name === 'get_account')?.payload.account);
				const others = found.slice(1, 4).map((row) => `${text(row.name)} (${num(row.days_quiet)} days)`);
				return answer(
					[
						`${text(account.name, text(found[0].name))} has not ordered in ${num(found[0].days_quiet)} days, and its usual gap is ${num(found[0].typical_gap_days)} days.`,
						`It billed ${dollars.format(num(account.revenue_last_year))} last year and ${dollars.format(num(account.revenue_ytd))} so far this year.`,
						others.length ? `Also quiet: ${others.join(', ')}.` : '',
						'Ask me to add a next step on it and I will, since that only adds a row.'
					]
						.filter(Boolean)
						.join(' ')
				);
			}

			if (shape === 'part') {
				const itemNo = itemNoIn(question);
				if (step === 0) {
					if (itemNo) return ask('get_part', { item_no: itemNo }, round);
					return ask(
						'run_sql',
						{
							why: 'The parts under their reorder point, worst first',
							sql: `select item_no, description, on_hand, open_qty, short_qty, projected_available, reorder_point
							      from nl.part_summary
							      where below_reorder_point
							      order by short_qty desc, projected_available
							      limit 5`
						},
						round
					);
				}

				const asked = seen.find((s) => s.name === 'get_part')?.payload;
				if (asked && typeof asked.error === 'string') {
					return answer(`${asked.error} Ask me for the parts under their reorder point and I will list those instead.`);
				}
				const part = object(asked?.part);
				if (Object.keys(part).length > 0) {
					return answer(
						[
							`${text(part.item_no)} (${text(part.description)}): ${num(part.on_hand)} on hand, ${num(part.on_production_order)} on production order, ${num(part.on_purchase_order)} on purchase order.`,
							`Open orders already claim ${num(part.open_qty)}, which leaves ${num(part.projected_available)} projected available${part.below_reorder_point ? `, under its reorder point of ${num(part.reorder_point)}` : ''}.`,
							`It sold ${num(part.units_12m)} units over the last twelve months (${dollars.format(num(part.revenue_12m))}) to ${num(part.buyers_12m)} accounts, and ${text(part.replenishment)} is how it is replenished, lead time ${text(part.lead_time, 'not set')}.`
						].join(' ')
					);
				}

				const short = rowsOf(seen.find((s) => s.name === 'run_sql')?.payload);
				if (short.length === 0) {
					return answer('No part is under its reorder point right now. Name a part number and I will read its position.');
				}
				return answer(
					`${short.length} ${short.length === 1 ? 'part is' : 'parts are'} under the reorder point. Worst: ` +
						short
							.map(
								(row) =>
									`${text(row.item_no)} (${num(row.on_hand)} on hand, ${num(row.short_qty)} short of open orders)`
							)
							.join(', ') +
						'. Name one and I will read its whole position.'
				);
			}

			if (shape === 'automation') {
				const rule = quietRule();
				if (step === 0) return ask('test_automation_rule', { rule }, round);

				const tested = seen.find((s) => s.name === 'test_automation_rule')?.payload ?? {};
				if (step === 1) {
					return ask(
						'propose_action',
						{
							summary: `A rule that adds a next step when an account has not ordered for twice its usual gap. It matches ${num(tested.matches_now)} ${num(tested.matches_now) === 1 ? 'account' : 'accounts'} right now.`,
							options: [
								{
									label: 'Save the rule and switch it on',
									tool: 'save_automation_rule',
									input: { rule, rule_id: null }
								},
								{
									label: 'Save it switched off, to look at first',
									tool: 'save_automation_rule',
									input: { rule: { ...rule, enabled: false }, rule_id: null }
								}
							]
						},
						round
					);
				}

				return answer(
					[
						`I drafted this as an automation rule: when an account's quiet stretch reaches twice its own usual gap and at least 21 days, add a next step for whoever owns the account, due in three days.`,
						`Tried against today's book it matches ${num(tested.matches_now)} ${num(tested.matches_now) === 1 ? 'account' : 'accounts'}, and the trial ran in a read-only transaction, so nothing was written.`,
						`Saving a rule is gated, because a saved rule writes on its own every night. The two options are above.`
					].join(' ')
				);
			}

			return answer(
				[
					'I can read the book and tell you what it says: accounts and their ordering rhythm, one commitment and what has been delivered against it, which windows closed short, a part\'s stock and how it sells, and any read-only SQL over the business tables.',
					'I can add a note or a next step, because those only add a row.',
					'Recording an outcome, changing confidence, applying an ERP export or saving an automation rule I can only propose: you approve it, and then it runs.',
					'Try one of the questions above.'
				].join(' ')
			);
		}
	};
}
