// Which sections a principal sees in the left rail.
//
// The rail is DERIVED, not configured. There is no per-role page picker and
// no column chooser: an entry is there when this person holds an authority
// that section is about, or owns a slice of the world it lists. An entry with
// nothing behind it is hidden rather than greyed, because a greyed control is
// a question ("why can't I?") and a missing one is an answer.
//
// $lib/nav.ts wrote the groups expecting this: it says every group has to
// survive being emptied, and visibleSections() drops a group with nothing
// left in it. So this file only decides which hrefs survive; the grouping,
// the labels, the icons and the order are the design system's.
//
// Hiding an entry hides the ENTRY and nothing else. Every page stays
// reachable by its URL and through the command palette, because a salesperson
// covering for somebody has to be able to open a warehouse screen once
// without being given a warehouse. Scope narrows what you may change, not
// what you may read (migration 0031's header says why).

import { NAV, type NavItem, type NavSection } from '$lib/nav';
import { routes } from '$lib/routes';
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
	/** One line, for the doc and for the explanation on /people. */
	because: string;
}

export const RAIL_RULES: RailRequirement[] = [
	{
		href: routes.today(),
		always: true,
		because: 'Everybody has a home, even on a morning when it is empty.'
	},
	{
		href: routes.desk(),
		dimensions: ['mailbox'],
		because: 'A desk belongs to whoever works its mailbox.'
	},
	{
		href: routes.workspace(),
		authorities: [
			'approve_reply',
			'approve_quote',
			'approve_agent_proposal',
			'release_purchase_order',
			'review_exception'
		],
		because: 'The queue is only useful to somebody who may approve something in it.'
	},
	{
		href: routes.operations(),
		authorities: ['run_import'],
		because: 'The morning files are applied by whoever may apply them.'
	},
	{
		href: routes.commitments(),
		dimensions: ['account'],
		because: 'A commitment sits on an account.'
	},
	{
		href: routes.forecast(),
		authorities: ['release_purchase_order', 'resolve_shortage'],
		dimensions: ['account'],
		because: 'Open orders are read by whoever has to do something about a late one.'
	},
	{
		href: routes.warehouse(),
		dimensions: ['warehouse'],
		authorities: ['confirm_pick', 'receive_stock', 'count_stock'],
		because: 'The floor screens belong to whoever is on the floor.'
	},
	{
		href: routes.rules(),
		authorities: ['change_policy'],
		because: 'A rule that runs itself is a policy.'
	},
	{
		href: routes.settings(),
		authorities: ['change_policy'],
		because: 'Keys, caps and what the agents may do are the policy holder’s.'
	},
	{
		href: routes.people(),
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

/**
 * The hrefs this principal's rail shows. Worked out once per request in
 * +layout.server.ts and sent to the layout as data.
 *
 * An href the rules do not mention is kept. A new section should appear for
 * everybody until somebody decides whose it is, which is a visible mistake;
 * the other way round it would vanish silently.
 */
export function railFor(policy: PrincipalPolicy): string[] {
	const ruled = new Map(RAIL_RULES.map((rule) => [rule.href, rule]));
	const every = NAV.flatMap((section) => section.items.map((item) => item.href));
	return [...new Set([...every, ...ruled.keys()])].filter((href) => {
		const rule = ruled.get(href);
		return rule ? railAllows(policy, rule) : true;
	});
}

/** The nav groups, narrowed to the hrefs this person's rail carries. */
export function railSections(rail: readonly string[], sections: NavSection[] = NAV): NavSection[] {
	const allowed = new Set(rail);
	return sections.map((section) => ({
		heading: section.heading,
		items: section.items.filter((item) => allowed.has(item.href))
	}));
}

/** The same narrowing over a flat list, for the phone bar. */
export function railItems(items: NavItem[], rail: readonly string[]): NavItem[] {
	const allowed = new Set(rail);
	return items.filter((item) => allowed.has(item.href));
}
