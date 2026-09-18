/*
  The navigation.

  The rail was twelve flat entries named after the nouns in the database, and
  it was heading past seventeen. Nouns are the wrong axis for this product.
  What a person does here is supervise: they clear the exceptions, they review
  what the agents did, and they set the policy the agents work to. So the rail
  is four groups, in that order.

    Today     the exception queue, and the home route. Nothing else.
    Desks     where agent work is reviewed. This is the working hour.
    Records   the few boards you cannot type your way to.
    Controls  policy and trust: how the business behaves.

  Two decisions worth stating because they are easy to undo by accident.

  1. The assistant is not a rail entry. Searching and asking are the same
     act, so the command palette is the assistant: type a part number and you
     get the part, type a question and you get the answer. /ask still exists
     for deep links and it is a palette action; it is not a chat box bolted to
     the side of the screen.
  2. Accounts, parts, vendors and quotes are gone from the rail. Every one of
     them is a lookup by name or number, which is what the palette is for. A
     permanent entry for a lookup is an entry a person walks past all day and
     uses twice. What is left in Records is the three boards that are not one
     record and so cannot be typed: the commitment board, open orders, and
     the floor.

  Reserved, and deliberately not linked until the page exists, because a rail
  entry that 404s is worse than a missing one:

    Desks     /procurement, the procurement desk
    Controls  /policies, /dictionary, /context, /people

  Which entries a given person sees is decided elsewhere (a roles branch
  derives it from authority and hides an entry with nothing behind it), so
  every group here has to survive being emptied. `visibleSections` drops a
  group with no entries left, and the layout renders a group of one exactly
  as it renders a group of five.
*/
import type { Component } from 'svelte';
import Boxes from '@lucide/svelte/icons/boxes';
import ClipboardCheck from '@lucide/svelte/icons/clipboard-check';
import ListChecks from '@lucide/svelte/icons/list-checks';
import Mails from '@lucide/svelte/icons/mails';
import Settings from '@lucide/svelte/icons/settings';
import ShieldCheck from '@lucide/svelte/icons/shield-check';
import SunMedium from '@lucide/svelte/icons/sun-medium';
import Route from '@lucide/svelte/icons/route';
import Warehouse from '@lucide/svelte/icons/warehouse';
import Workflow from '@lucide/svelte/icons/workflow';
import Scale from '@lucide/svelte/icons/scale';
import BookMarked from '@lucide/svelte/icons/book-marked';
import ShoppingCart from '@lucide/svelte/icons/shopping-cart';
import Users from '@lucide/svelte/icons/users';
import type { Role } from './types';
import { routes } from './routes';

export interface NavItem {
	href: string;
	label: string;
	/** What a person does here, one line. The palette shows it. */
	hint: string;
	/*
	  The lucide icon component. `aria-hidden` is in the type because the rail
	  passes it: the label next to the icon is the accessible name, and the
	  glyph repeating it would be read twice.
	*/
	icon: Component<{ size?: number; strokeWidth?: number; 'aria-hidden'?: boolean | 'true' }>;
}

export interface NavSection {
	/** A visible label above the group, not a decorative divider. */
	heading: string;
	items: NavItem[];
}

export const NAV: NavSection[] = [
	{
		heading: 'Today',
		items: [
			{
				href: routes.today(),
				label: 'Today',
				hint: 'Everything waiting on a person, and nothing else',
				icon: SunMedium
			}
		]
	},
	{
		heading: 'Desks',
		items: [
			{
				href: routes.desk(),
				label: 'Order desk',
				hint: 'Customer email the desk agent read, and the replies it drafted',
				icon: Mails
			},
			{
				href: routes.procurement(),
				label: 'Procurement desk',
				hint: 'What to buy, how much, from whom and by when',
				icon: ShoppingCart
			},
			{
				href: routes.workspace(),
				label: 'Approval queue',
				hint: 'Approve, correct or reject what any agent proposed',
				icon: ClipboardCheck
			},
			{
				href: routes.operations(),
				label: 'Morning exports',
				hint: "The ERP files staged overnight: apply them, or hold one and say why",
				icon: Warehouse
			}
			// Reserved: /procurement, the procurement desk.
		]
	},
	{
		heading: 'Records',
		items: [
			{
				href: routes.commitments(),
				label: 'Commitments',
				hint: 'What buyers promised to buy, and what has landed against it',
				icon: ListChecks
			},
			{
				href: routes.forecast(),
				label: 'Open orders',
				hint: 'When each open line will really ship, and what it is waiting on',
				icon: Route
			},
			{
				href: routes.warehouse(),
				label: 'Inventory',
				hint: 'Bins, the stock ledger, the pick queue and the counts due',
				icon: Boxes
			}
		]
	},
	{
		heading: 'Controls',
		items: [
			{
				href: routes.rules(),
				label: 'Automations',
				hint: 'The rules that run every night, each as one plain sentence',
				icon: Workflow
			},
			{
				href: routes.agents(),
				label: 'Agents',
				hint: 'What each agent handled, what it refused to do, and how far it may go alone',
				icon: ShieldCheck
			},
			{
				href: routes.policies(),
				label: 'Policies',
				hint: 'The rules everybody and every agent decides by, and why a value won',
				icon: Scale
			},
			{
				href: routes.people(),
				label: 'People',
				hint: 'Who answers for what, what they may approve, and what they may see',
				icon: Users
			},
			{
				href: routes.dictionary(),
				label: 'Dictionary',
				hint: 'Every field the app knows, what it means and who may be shown it',
				icon: BookMarked
			},
			{
				href: routes.settings(),
				label: 'Settings',
				hint: 'What the agents may do, who they may write to, what they cost',
				icon: Settings
			}
			// Reserved: /context.
		]
	}
];

/** The groups that still have something in them. */
export function visibleSections(sections: NavSection[] = NAV): NavSection[] {
	return sections.filter((section) => section.items.length > 0);
}

/** Every entry, flat. The palette and the "which section am I in" check use it. */
export const NAV_ITEMS: NavItem[] = NAV.flatMap((section) => section.items);

/**
 * The phone bar: Today, the desk this person actually works, and that is it.
 * Search is a control in the top bar rather than an entry here, and
 * everything else on a phone is reached by typing its name.
 *
 * A bar of twelve icons scrolls sideways, which means most of it is off
 * screen, which means it is not navigation.
 */
export function phoneItems(role: Role): NavItem[] {
	const byHref = new Map(NAV_ITEMS.map((item) => [item.href, item]));
	const today = byHref.get(routes.today());
	// An account manager's desk is the order desk. Everybody else works the
	// morning exports, which is where the day's files land.
	const desk = byHref.get(role === 'account_manager' ? routes.desk() : routes.operations());
	return [today, desk].filter((item): item is NavItem => Boolean(item));
}

/** Routes the rail does not link but other pages and the palette still reach. */
export const UNRAILED = [
	{ href: routes.accounts(), label: 'Accounts', hint: 'The book: who buys, how often, and what is promised' },
	{ href: routes.parts(), label: 'Parts', hint: 'What we sell, what it earns and what is on the shelf' },
	{ href: routes.vendors(), label: 'Vendors', hint: 'Who supplies the bought parts, and on what terms' },
	{ href: routes.ask(), label: 'Ask', hint: 'Put a question to the whole database' },
	{ href: routes.search(), label: 'Search', hint: 'Accounts, parts and vendors on one results page' },
	{ href: routes.settingsMcp(), label: 'Coding agents', hint: 'Connect an outside agent to this app' }
];
