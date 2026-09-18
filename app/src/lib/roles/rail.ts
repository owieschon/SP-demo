// Which sections a principal sees in the left rail.
//
// The rail is DERIVED, not configured. There is no per-role page picker and no
// column chooser: an entry is there when this person holds an authority that
// section is about, or owns a slice of the world it lists. An entry with
// nothing behind it is hidden rather than greyed, because a greyed control is
// a question ("why can't I?") and a missing one is an answer.
//
// Hiding an entry hides the ENTRY and nothing else. Every page stays
// reachable by its URL and by search, because a salesperson covering for
// somebody has to be able to open a warehouse page once without being given a
// warehouse. Scope narrows what you may change, not what you may read
// (migration 0031's header says why).

import { NAV, type NavItem, type NavSection } from '../nav.ts';
import type { Authority, PrincipalPolicy, ScopeDimension } from './types.ts';
import { hasScope, holds } from './types.ts';

export interface RailRequirement {
	href: string;
	/** Any one of these authorities is enough. */
	authorities?: Authority[];
	/** Or a claim on any one of these dimensions. */
	dimensions?: ScopeDimension[];
	/** Sections everybody gets. */
	always?: true;
	/** One line for the doc and for the /people page's explanation. */
	because: string;
}

export const RAIL_RULES: RailRequirement[] = [
	{ href: '/ask', always: true, because: 'Anybody may ask a question about their own book.' },
	{
		href: '/workspace',
		authorities: ['approve_reply', 'approve_quote', 'approve_agent_proposal', 'review_exception'],
		because: 'The queue is only useful to somebody who may approve something in it.'
	},
	{ href: '/desk', dimensions: ['mailbox'], because: 'A desk belongs to whoever works its mailbox.' },
	{
		href: '/settings',
		authorities: ['change_policy'],
		because: 'Keys and caps are the policy holder’s.'
	},
	{ href: '/commitments', dimensions: ['account'], because: 'A commitment sits on an account.' },
	{ href: '/accounts', dimensions: ['account'], because: 'The book is the account list.' },
	{
		href: '/rfq',
		authorities: ['approve_quote'],
		because: 'A quote request ends in a quote somebody signs.'
	},
	{ href: '/parts', always: true, because: 'The catalog is everybody’s.' },
	{
		href: '/vendors',
		dimensions: ['vendor'],
		authorities: ['release_purchase_order', 'accept_price_increase'],
		because: 'Suppliers are the buyer’s side of the world.'
	},
	{
		href: '/operations',
		authorities: ['run_import', 'resolve_shortage', 'release_purchase_order'],
		because: 'The daily load and the forecast are operations work.'
	},
	{
		href: '/warehouse',
		dimensions: ['warehouse'],
		authorities: ['confirm_pick', 'receive_stock', 'count_stock'],
		because: 'The floor screens belong to whoever is on the floor.'
	},
	{
		href: '/automations',
		authorities: ['change_policy'],
		because: 'A rule that runs itself is a policy.'
	},
	/*
	  Everybody, deliberately. A trust surface only works if the sceptic can
	  open it: somebody reviewing a drafted reply cannot judge it without
	  knowing what wrote it and what that thing is allowed to do. Reading it
	  gives nothing away, because row-level security still decides which runs
	  each person sees, and the two writes on it are gated by the database
	  (change_policy to raise autonomy; nothing at all to pull the brake).
	*/
	{
		href: '/agents',
		always: true,
		because: 'What an agent may do, and what it refused, is not a secret inside a company.'
	},
	{
		href: '/people',
		always: true,
		because: 'Who may approve what is not a secret inside a company.'
	}
];

/** Does this principal have any reason to see this section? */
export function railAllows(policy: PrincipalPolicy, rule: RailRequirement): boolean {
	if (rule.always) return true;
	if (rule.authorities?.some((a) => holds(policy, a))) return true;
	if (rule.dimensions?.some((d) => hasScope(policy, d))) return true;
	return false;
}

/** The hrefs this principal's rail shows, in the order the rules are written. */
export function railFor(policy: PrincipalPolicy): string[] {
	return RAIL_RULES.filter((rule) => railAllows(policy, rule)).map((rule) => rule.href);
}

/*
  The two shapes the shell needs, from the one list of hrefs above.

  These keep the filtering in one place rather than in the layout's markup,
  and they keep the SECTIONS intact: a section whose entries are all hidden
  comes back empty rather than missing, and nav.visibleSections drops it.
  That is what lets a group survive being emptied, which is the whole reason
  the rail can be derived at all.
*/

/** The rail's sections, holding only the entries this principal may see. */
export function railSections(allowed: string[], sections: NavSection[] = NAV): NavSection[] {
	return sections.map((section) => ({
		...section,
		items: section.items.filter((item) => allowed.includes(item.href))
	}));
}

/** Keep only the entries this principal may see, in the order given. */
export function railItems(items: NavItem[], allowed: string[]): NavItem[] {
	return items.filter((item) => allowed.includes(item.href));
}
