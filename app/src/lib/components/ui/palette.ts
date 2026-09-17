/*
  What the command palette knows and how it ranks it.

  The matching is here, in plain TypeScript, so it can be tested without a
  browser and so the component above it stays a list and a text box.

  Two kinds of thing are in the list. Screens and actions are static: they
  ship with the app and are searchable the moment the palette opens. Records
  (accounts, parts, vendors) are fetched from /api/palette as the person
  types, because there are thousands of them.
*/
import { NAV_ITEMS, UNRAILED } from '$lib/nav';
import { routes } from '$lib/routes';

export type PaletteKind = 'action' | 'screen' | 'account' | 'part' | 'vendor';

export interface PaletteEntry {
	/** Unique within one list, so Svelte can key the rows. */
	id: string;
	kind: PaletteKind;
	label: string;
	/** One line saying what happens, shown under the label. */
	hint?: string;
	href: string;
	/** Extra words that should match but are not shown, e.g. a record number. */
	keywords?: string;
}

export const KIND_LABEL: Record<PaletteKind, string> = {
	action: 'Do',
	screen: 'Go to',
	account: 'Accounts',
	part: 'Parts',
	vendor: 'Vendors'
};

/** The order the groups appear in. Actions first: this is a verb box. */
export const KIND_ORDER: PaletteKind[] = ['action', 'screen', 'account', 'part', 'vendor'];

/*
  The actions. Every one of these is something the app can really do today,
  and each goes to the control that does it rather than doing it from here: a
  palette that writes to the database behind one keystroke is a palette that
  writes to the database by accident.
*/
export const ACTIONS: PaletteEntry[] = [
	{
		id: 'action-answer',
		kind: 'action',
		label: 'Answer the oldest window that closed short',
		hint: 'Kept, pushed or did not buy',
		href: routes.commitmentsAnswer(),
		keywords: 'outcome closed short broken pushed kept commitment'
	},
	{
		id: 'action-queue-mail',
		kind: 'action',
		label: 'Approve or correct the drafts the order desk wrote',
		hint: 'The email queue, oldest first',
		href: routes.workspace('mail'),
		keywords: 'draft email reply send desk outbox'
	},
	{
		id: 'action-queue-rfq',
		kind: 'action',
		label: 'Approve or correct a quote an agent drafted',
		hint: 'The quote request queue',
		href: routes.workspace('rfq'),
		keywords: 'quote rfq draft price approve'
	},
	{
		id: 'action-agent-activity',
		kind: 'action',
		label: 'Show what the agents did and what a person changed',
		hint: 'Recent decisions, with who edited before approving',
		href: routes.workspaceDecisions(),
		keywords: 'activity history audit trust autonomy edited rejected'
	},
	{
		id: 'action-upload',
		kind: 'action',
		label: "Load this morning's ERP export",
		hint: 'Staged and checked before anything changes',
		href: routes.operations(),
		keywords: 'csv import upload snapshot open orders'
	},
	{
		id: 'action-ship-check',
		kind: 'action',
		label: 'Check whether we can ship a part by a date',
		hint: 'Answers from stock, purchase orders and the shop floor',
		href: `${routes.forecast()}#atp-title`,
		keywords: 'available to promise atp ship date late'
	},
	{
		id: 'action-new-rule',
		kind: 'action',
		label: 'Write a new automation rule',
		hint: 'A trigger, some conditions and one action',
		href: routes.newRule(),
		keywords: 'automation rule trigger nightly'
	},
	{
		id: 'action-desk-policy',
		kind: 'action',
		label: 'Change what the order desk may send, and to whom',
		hint: 'The allowed recipients are the only addresses it can reach',
		href: `${routes.settings()}#mail-desks`,
		keywords: 'policy allowlist recipients pause desk mail'
	},
	{
		id: 'action-model-budget',
		kind: 'action',
		label: 'Change how many model calls a day the agents get',
		hint: 'Per person and for the whole server',
		href: `${routes.settings()}#keys-and-models`,
		keywords: 'policy budget cap limit cost tokens model'
	},
	{
		id: 'action-ask',
		kind: 'action',
		label: 'Ask a question of the whole database',
		hint: 'It can read anything and only propose writes',
		href: routes.ask(),
		keywords: 'assistant question sql report'
	},
	{
		id: 'action-switch-user',
		kind: 'action',
		label: 'Sign in as somebody else',
		hint: 'Every query then runs as that person',
		href: routes.signin(),
		keywords: 'user switch role permissions'
	}
];

/*
  The screens. The rail's own entries come straight from nav.ts so the two
  cannot drift apart, and then the screens the rail deliberately does NOT
  carry (accounts, parts, vendors, quote requests, ask, search) are added
  here. That is the trade the rail makes: those pages left the sidebar on the
  understanding that this box reaches them in three keystrokes.
*/
export const SCREENS: PaletteEntry[] = [...NAV_ITEMS, ...UNRAILED].map((item) => ({
	id: `screen-${item.href}`,
	kind: 'screen' as const,
	label: item.label,
	hint: item.hint,
	href: item.href
}));

export const STATIC_ENTRIES: PaletteEntry[] = [...ACTIONS, ...SCREENS];

function normalize(value: string): string {
	return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * How well one entry answers a query, or null for no match at all.
 *
 * Higher is better. The steps are coarse on purpose: a person typing "acc"
 * wants the Accounts screen above an account whose city happens to contain
 * those letters, and nothing subtler than that is worth explaining.
 */
export function scoreEntry(query: string, entry: PaletteEntry): number | null {
	const q = normalize(query);
	if (!q) return 0;

	const label = normalize(entry.label);
	const extra = normalize(`${entry.keywords ?? ''} ${entry.hint ?? ''}`);

	if (label === q) return 100;
	if (label.startsWith(q)) return 80;
	// The start of any word in the label: "queue" finds "The email queue".
	if (label.includes(` ${q}`)) return 60;
	if (label.includes(q)) return 40;
	if (extra.includes(q)) return 25;

	// Every word somewhere, in any order: "approve draft" finds "Approve or
	// correct the drafts the order desk wrote".
	const words = q.split(' ');
	if (words.length > 1 && words.every((word) => label.includes(word) || extra.includes(word))) {
		return 15;
	}
	return null;
}

/**
 * The entries that match, best first, keeping the order they were given in
 * for ties so the list does not jump around as a person types.
 */
export function matchEntries(query: string, entries: PaletteEntry[], limit = 12): PaletteEntry[] {
	const scored: { entry: PaletteEntry; score: number; at: number }[] = [];
	entries.forEach((entry, at) => {
		const score = scoreEntry(query, entry);
		if (score !== null) scored.push({ entry, score, at });
	});
	scored.sort((a, b) => b.score - a.score || a.at - b.at);
	return scored.slice(0, limit).map((row) => row.entry);
}

/** The matches grouped for display, in KIND_ORDER, empty groups dropped. */
export function groupEntries(entries: PaletteEntry[]): { kind: PaletteKind; entries: PaletteEntry[] }[] {
	return KIND_ORDER.map((kind) => ({
		kind,
		entries: entries.filter((entry) => entry.kind === kind)
	})).filter((group) => group.entries.length > 0);
}
