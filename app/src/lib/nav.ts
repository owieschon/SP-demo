/*
  The navigation, and what the command palette can jump to.

  The rail used to be twelve flat items named after the nouns in the database.
  It is now grouped by the question a person is answering, because that is what
  this product is: the agents do the work, and a person's time goes on the few
  things only a person can decide, on checking whether the agents can be
  trusted with more, and on setting the policy they work to.

    Needs me   the exceptions: the queue, the outbox, the closed-short questions
    Agents     what the agents are doing, and what they were refused
    Records    the things the work is about
    Operations the flow of orders through the building
    Setup      how the business behaves

  Two sections have a reserved slot for a page being built elsewhere:
  `/agents` (the autonomy ladder, activity and refusals) belongs in Agents,
  and `/policies` plus `/dictionary` belong in Setup. Neither is linked here
  until it exists, because a rail item that 404s is worse than a missing one.
*/
import type { Component } from 'svelte';
import Boxes from '@lucide/svelte/icons/boxes';
import Building2 from '@lucide/svelte/icons/building-2';
import ClipboardCheck from '@lucide/svelte/icons/clipboard-check';
import Inbox from '@lucide/svelte/icons/inbox';
import ListChecks from '@lucide/svelte/icons/list-checks';
import Mails from '@lucide/svelte/icons/mails';
import Package from '@lucide/svelte/icons/package';
import Settings from '@lucide/svelte/icons/settings';
import Sparkles from '@lucide/svelte/icons/sparkles';
import SunMedium from '@lucide/svelte/icons/sun-medium';
import Truck from '@lucide/svelte/icons/truck';
import Warehouse from '@lucide/svelte/icons/warehouse';
import Workflow from '@lucide/svelte/icons/workflow';
import Route from '@lucide/svelte/icons/route';
import { routes } from './routes';

export interface NavItem {
	href: string;
	label: string;
	/** What a person does here, one line. The palette shows it. */
	hint: string;
	icon: Component<{ size?: number; strokeWidth?: number }>;
}

export interface NavSection {
	heading: string;
	items: NavItem[];
}

export const NAV: NavSection[] = [
	{
		heading: 'Needs me',
		items: [
			{
				href: routes.today(),
				label: 'Today',
				hint: 'Everything waiting on a person, and nothing else',
				icon: SunMedium
			},
			{
				href: routes.workspace(),
				label: 'Queue',
				hint: 'Approve, correct or reject what an agent proposed',
				icon: ClipboardCheck
			},
			{
				href: routes.desk(),
				label: 'Order desk',
				hint: 'Customer email the desk agent answered, and its drafts',
				icon: Mails
			}
		]
	},
	{
		heading: 'Agents',
		items: [
			{
				href: routes.ask(),
				label: 'Ask',
				hint: 'Ask a question of the whole database',
				icon: Sparkles
			}
			// Reserved: /agents, the autonomy ladder, activity and refusals.
		]
	},
	{
		heading: 'Records',
		items: [
			{
				href: routes.commitments(),
				label: 'Commitments',
				hint: 'What buyers promised to buy, and what has landed',
				icon: ListChecks
			},
			{
				href: routes.accounts(),
				label: 'Accounts',
				hint: 'The book: who buys, how often, and what is promised',
				icon: Building2
			},
			{
				href: routes.parts(),
				label: 'Parts',
				hint: 'What we sell, what it earns and what is on the shelf',
				icon: Package
			},
			{
				href: routes.vendors(),
				label: 'Vendors',
				hint: 'Who supplies the bought parts, and on what terms',
				icon: Truck
			},
			{
				href: routes.rfq(),
				label: 'RFQ intake',
				hint: 'Emailed requests read into a checked draft quote',
				icon: Inbox
			}
		]
	},
	{
		heading: 'Operations',
		items: [
			{
				href: routes.operations(),
				label: 'Operations',
				hint: "This morning's ERP export, held or applied",
				icon: Warehouse
			},
			{
				href: routes.forecast(),
				label: 'Forecast',
				hint: 'When each open line will really ship, and why',
				icon: Route
			},
			{
				href: routes.warehouse(),
				label: 'Warehouse',
				hint: 'Bins, the stock ledger, the pick queue and counts',
				icon: Boxes
			}
		]
	},
	{
		heading: 'Setup',
		items: [
			{
				href: routes.automations(),
				label: 'Automations',
				hint: 'The rules that run every night, in plain English',
				icon: Workflow
			},
			{
				href: routes.settings(),
				label: 'Settings',
				hint: 'What the agents may do, and what they cost',
				icon: Settings
			}
			// Reserved: /policies (how the business behaves) and /dictionary.
		]
	}
];

/** Every rail item, flat, for the "which section am I in" check. */
export const NAV_ITEMS: NavItem[] = NAV.flatMap((section) => section.items);
