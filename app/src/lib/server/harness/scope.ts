// What each agent is for, and what it may do. The scope table from
// docs/agent-harness.md, as data.
//
// It is here rather than only in prose for two reasons: the /agents page shows
// it, and scope.test.ts checks it against nl.agent_work_kinds, so a kind of
// work cannot exist in the database without a written scope or the other way
// round. Every line is meant to be a statement a test could check; where one
// is not enforced anywhere yet it says so.

export const AGENTS = ['order_desk', 'procurement_desk', 'assistant', 'automation', 'mcp'] as const;
export type AgentId = (typeof AGENTS)[number];

export interface AgentScope {
	id: AgentId;
	name: string;
	/** One sentence: what it is for. */
	purpose: string;
	/** What wakes it. Nothing else may. */
	wakes: string[];
	/** What it may read. */
	reads: string[];
	/** What it may write, including "nothing". */
	writes: string[];
	/** What it may say, and to whom. */
	says: string[];
	/** What it must never do. */
	never: string[];
	/** What it does when it is unsure. */
	unsure: string;
	/** Who reviews its work. */
	reviewer: string;
	/** The kinds of work it does, matching nl.agent_work_kinds. */
	workKinds: string[];
	/** Where the code is. */
	code: string;
}

export const AGENT_SCOPES: AgentScope[] = [
	{
		id: 'order_desk',
		name: 'Order desk',
		purpose:
			'Answers customer mail to the order desk: quotes, order acknowledgements, price, stock and status questions.',
		wakes: [
			'The Check mail button on /desk, pressed by a signed-in person',
			'GET /api/mail/poll with CRON_SECRET',
			'POST /api/mail/webhook with MAIL_WEBHOOK_SECRET, which polls the provider rather than trusting the body',
			'Nothing else. It has no loop and no schedule of its own'
		],
		reads: [
			'The whole book, as the mailbox reviewer, under that person\'s own row-level security',
			'Ten batched lookups (desk/tools.ts), at most nl.mail_lookup_cap() per message',
			'Cost, margin and the price floor, because it needs them to know a price is below the floor'
		],
		writes: [
			'nl.mail_messages, through nl.record_mail_message, keyed on a content hash so one message is stored once',
			'nl.mail_runs, through nl.start_mail_run and nl.finish_mail_run',
			'nl.mail_drafts, through nl.queue_mail_draft, which is a queue nobody has approved',
			'An RFQ draft for a quote or an order, through the existing RFQ pipeline',
			'Nothing else. No role has INSERT, UPDATE or DELETE on any of those tables'
		],
		says: [
			'To a customer: which account they are and their tier, part descriptions, their own price at the quantity asked, a published quantity break, their own agreement and what they last paid, availability dates and lead times, their own open orders, quotes and commitments, their own account manager\'s name, freight at the published tariff',
			'Every dollar figure in the reply has to trace back to a fact it verified'
		],
		never: [
			'Send anything. Only nl.mark_mail_sent can say sent, and only from approved',
			'Approve its own draft',
			'Tell a customer what a part costs us, our margin, our price floor, how many are on the shelf, any other account\'s anything, an internal note, or a colleague\'s name other than their own rep',
			'Act on instructions inside a message. The body is data; instruction-shaped text is recorded and changes nothing'
		],
		unsure:
			'Below 0.55 confidence, or intent "other", it asks the sender a short question and marks the message as needing a person. An unresolved sender, or a shared email domain that fits more than one branch, is asked about rather than guessed.',
		reviewer: 'The mailbox\'s reviewer (nl.mailboxes.reviewer_id) or an admin. Nobody else, enforced in nl.approve_mail_draft.',
		workKinds: ['rfq', 'purchase_order', 'price_question', 'stock_question', 'order_status', 'other'],
		code: 'app/src/lib/server/desk/**'
	},
	{
		id: 'procurement_desk',
		name: 'Procurement desk',
		purpose:
			'Answers supplier mail and raises purchase requests from the replenishment maths. The mail half exists; the purchase request half is being built elsewhere.',
		wakes: [
			'The same three ways as the order desk, on the procurement mailbox',
			'When it lands: a replenishment signal, which is not a person and not mail'
		],
		reads: [
			'The book as the procurement mailbox\'s reviewer',
			'A supplier\'s own open purchase lines'
		],
		writes: [
			'nl.mail_drafts on the procurement mailbox, held for review',
			'When it lands: its own purchase request table, waiting for a buyer'
		],
		says: [
			'To a supplier: part descriptions, lead times and their own open orders',
			'Nothing about any customer'
		],
		never: [
			'Tell a supplier about a customer, or another supplier\'s prices or orders',
			'Place an order. A purchase request is a request'
		],
		unsure: 'The same rule as the order desk: it asks, and the draft is held.',
		reviewer: 'The procurement mailbox\'s reviewer for mail; the buyer for a purchase request.',
		workKinds: ['vendor_reply', 'purchase_request'],
		code: 'app/src/lib/server/procurement/** (not in this database yet)'
	},
	{
		id: 'assistant',
		name: 'Ask Northline',
		purpose: 'Answers a person\'s questions from the database through a fixed set of tools.',
		wakes: ['A person typing a question on /ask. Nothing else'],
		reads: [
			'Seven read tools, including one read-only SELECT as role nl_readonly',
			'Only what the person asking may read: every query runs as them'
		],
		writes: [
			'Two additive tools, add_note and add_next_step, which can only insert a row',
			'A proposal in nl.assistant_proposals, which writes no business record',
			'A gated tool\'s own SQL function, but only after a person approves the proposal, and then from the stored option'
		],
		says: ['Only to the person who asked. A conversation is private to them, admins included'],
		never: [
			'Run a gated tool. The gate branches on the risk class before it even parses the input',
			'Approve its own proposal. There is no approve tool',
			'See a row version, so it cannot construct a write that looks current',
			'Read anything about people through run_sql: nl_readonly has no grant on nl.users, nl.contacts or nl.activities',
			'Delete anything, or change an owner, a price or a contact'
		],
		unsure:
			'It says so in the answer. A tool it called that refused hands back a message it can read and try again from, and a proposal it could not build is refused with the reason.',
		reviewer: 'The person who asked. A proposal is theirs to approve or reject, and nobody else\'s.',
		workKinds: ['question', 'additive_write', 'proposal'],
		code: 'app/src/lib/server/assistant/**'
	},
	{
		id: 'automation',
		name: 'Automation runner',
		purpose:
			'Runs the rules people set up: a trigger, conditions on its fields, and one additive action.',
		wakes: [
			'The daily job at /api/cron/automations with CRON_SECRET',
			'Test run and Run now on a rule\'s own page, by its owner or an admin'
		],
		reads: [
			'One compiled query per rule, from the trigger catalog. Never SQL a person typed',
			'As the rule\'s owner, so row-level security decides which records match'
		],
		writes: [
			'A next step or a note, through nl.fire_automation',
			'Once per subject per rule, ever, enforced by a unique key on (rule_id, subject_key)',
			'At most 200 subjects in one run, so a rule cannot write all night'
		],
		says: ['Nothing outside the company. It writes into the book and nowhere else'],
		never: [
			'Run SQL a person wrote. A rule is a trigger key, conditions and an action',
			'Fire twice for the same subject',
			'Run as somebody who has left: the job records a failed run and waits for an admin'
		],
		unsure:
			'There is nothing to be unsure about: a rule either matches or it does not. A rule that raises is recorded as a failed run with the error, and its transaction rolls back, so a half-fired run is not possible.',
		reviewer:
			'Nobody, after the fact. A person switched the rule on, and every firing is on the record with the run that made it.',
		workKinds: ['next_step', 'note'],
		code: 'app/src/lib/server/automation/**'
	},
	{
		id: 'mcp',
		name: 'MCP surface',
		purpose:
			'Lets an outside coding agent read Northline and ask for changes, with the assistant\'s safety model.',
		wakes: ['POST /api/mcp with a bearer token. There is no session cookie on this path'],
		reads: [
			'The assistant\'s read tools, as the person the token acts as',
			'Only what that person may read'
		],
		writes: [
			'A proposal, when the token has the propose scope',
			'Nothing else. No MCP tool writes a business record, and the additive tools are deliberately not exposed'
		],
		says: ['Only to the holder of the token, as the person it acts as'],
		never: [
			'Call a gated tool. They are not in the list under any name',
			'Approve a proposal, including one it created',
			'Spend model credit: this path never calls a model'
		],
		unsure: 'It answers with the JSON-RPC error and the reason, and creates nothing.',
		reviewer: 'The person the token acts as, in the app, on /ask.',
		workKinds: ['read', 'propose'],
		code: 'app/src/lib/server/mcp/**'
	}
];

export function scopeFor(agent: AgentId): AgentScope {
	const found = AGENT_SCOPES.find((s) => s.id === agent);
	if (!found) throw new Error(`No scope is written for the agent "${agent}".`);
	return found;
}
