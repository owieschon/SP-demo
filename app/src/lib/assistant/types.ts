// What the Ask Northline pages receive from the server, and the words the
// page uses for the parts of the feature. Nothing in here touches the
// database, so both the server and the browser can import it.

/**
 * What a tool is allowed to do. The runtime, not the prompt, decides:
 *   read      runs as soon as the model asks for it, and writes nothing
 *   additive  runs too, and can only ever add a row (a note, a next step)
 *   gated     never runs when the model asks. The model has to propose it
 *             and a person has to approve it.
 *   propose   the one tool that makes a proposal
 */
export type RiskClass = 'read' | 'additive' | 'gated' | 'propose';

export const RISK_LABEL: Record<RiskClass, string> = {
	read: 'Looked something up',
	additive: 'Added something new',
	gated: 'Needs your approval',
	propose: 'Proposed an action'
};

/** How one tool call ended. */
export type LookupOutcome = 'ran' | 'gated' | 'refused' | 'failed';

/** One line under "what the assistant looked up". */
/**
 * Who answered: the scripted model, the real model, or an outside agent
 * through the MCP server.
 */
export type AskMode = 'mock' | 'live' | 'mcp';

export interface LookupView {
	round: number;
	name: string;
	risk: RiskClass;
	input: unknown;
	outcome: LookupOutcome;
	/** Rows a read tool returned, when the tool counts rows. */
	rows: number | null;
	ms: number;
	/** Why it was gated, refused or failed. Empty when it just ran. */
	note: string;
	/**
	 * Did the result match the shape the tool declares it answers with?
	 * null when the tool declares no shape, or when it did not run.
	 *
	 * The MCP server sends the payload as structuredContent only when this
	 * is true. Here it is recorded rather than acted on, so a query that
	 * quietly stops returning a promised column is visible in the
	 * conversation as well as in the test that holds the contract.
	 */
	conforms: boolean | null;
}

export type ProposalStatus = 'draft' | 'approved' | 'rejected' | 'executed';

export interface ProposalOptionView {
	label: string;
	tool: string;
	/** Exactly what would be written, as the model named it. */
	input: Record<string, unknown>;
}

export interface ProposalView {
	id: number;
	summary: string;
	status: ProposalStatus;
	options: ProposalOptionView[];
	chosenIndex: number | null;
	reason: string;
	/** The last failed execution, if there was one. It can be tried again. */
	error: string | null;
	/** What the write returned once it ran. */
	result: Record<string, unknown> | null;
	/** Row version, sent back with a decision. */
	updatedAt: string;
	decidedAt: string | null;
}

export type MessageRole = 'question' | 'answer' | 'decision';

export interface MessageView {
	id: number;
	seq: number;
	role: MessageRole;
	body: string;
	createdAt: string;
	/** Only on an answer: what the model asked for, in order. */
	lookups: LookupView[];
	/** Only on an answer that proposed something. */
	proposal: ProposalView | null;
}

export interface ConversationView {
	id: number;
	title: string;
	mode: AskMode;
	messageCount: number;
	/** How many more messages fit before a new conversation is needed. */
	messagesLeft: number;
	createdAt: string;
	updatedAt: string;
	messages: MessageView[];
}

export interface ConversationListItem {
	id: number;
	title: string;
	mode: AskMode;
	messageCount: number;
	updatedAt: string;
	/** Proposals still waiting for a decision. */
	openProposals: number;
}

/** Which model is answering, and whether the real one could be switched on. */
export interface ModeView {
	mode: AskMode;
	/** Never says "Claude" unless Claude is really answering. */
	label: string;
	model: string | null;
	/** The server has a key and a passphrase, so live mode is possible. */
	configured: boolean;
	/** This person typed the passphrase within the last hour. */
	unlocked: boolean;
}

/** The limits, so the page can say them out loud. */
export interface CapsView {
	rounds: number;
	toolResultBytes: number;
	conversationMessages: number;
	userUsed: number;
	userLimit: number;
	globalUsed: number;
	globalLimit: number;
}

/** What "Try one of these" offers. Each one works in scripted demo mode. */
export const STARTERS: { question: string; why: string }[] = [
	{
		question: 'Which of my commitment windows closed short?',
		why: 'Reads the board, then offers to record an outcome. You approve it.'
	},
	{
		question: 'Has any of my accounts gone quiet?',
		why: 'Compares each account against its own ordering rhythm.'
	},
	{
		question: 'How much stock is there of item L3515-630SC?',
		why: 'On hand, on order, open demand and how fast it sells.'
	},
	{
		question: 'Remind me when an account goes quiet for twice its usual gap.',
		why: 'Drafts an automation rule, tries it out, and proposes saving it.'
	}
];

/** The page's one-line promise above every proposal. */
export const APPROVAL_PROMISE = 'Nothing runs until you approve.';
