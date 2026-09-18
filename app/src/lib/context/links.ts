// Where a citation's source document actually lives, as a link.
//
// A fact has to be traceable to a quoted snippet in one click, which the
// citation itself does: the snippet travels with the fact. This adds the
// second click, into the real record, for the stores that have a page.
//
// Some of them do not. An archived letter from 2024 and the text read out of
// a purchase order PDF have no page in this app, and inventing one would be
// worse than saying so: the snippet, the source and the date are the
// citation, and the label says which store it is in.
import { routes } from '$lib/routes';
import type { SourceLink } from './types';

const STORE_LABEL: Record<string, string> = {
	mail_messages: 'Order desk message',
	mail_archive: 'Archived mail',
	activities: 'Activity note',
	context_entries: 'Hand entry',
	legacy_crm_rows: 'Legacy CRM export row',
	export_snapshot_lines: 'ERP export row',
	customers: 'Customer master row',
	rfq_attachments: 'Quote request attachment'
};

/**
 * A link into the record a citation came from, when this app has a page for
 * it, and an honest label when it does not.
 */
export function sourceLink(citation: { ref_table: string; ref_id: string }): SourceLink {
	const label = STORE_LABEL[citation.ref_table] ?? citation.ref_table.replace(/_/g, ' ');
	switch (citation.ref_table) {
		case 'mail_messages':
			// The desk's own message page shows the mail as it arrived, with
			// every lookup the agent made beside it.
			return { href: routes.deskMessage(Number(citation.ref_id)), label };
		case 'customers':
			return { href: routes.account(citation.ref_id), label };
		case 'rfq_attachments':
			return { href: null, label };
		default:
			return { href: null, label };
	}
}

/** "21 to 28 days" from a fact's own display string, or the raw value. */
export function factValue(fact: { value_display: string; unit?: string }): string {
	return fact.value_display;
}

/** How stale, in the words a person would use. */
export function stalenessLabel(daysStale: number): string {
	if (daysStale <= 0) return 'fresh';
	if (daysStale < 30) return `${daysStale} day${daysStale === 1 ? '' : 's'} past its horizon`;
	const months = Math.round(daysStale / 30);
	return `${months} month${months === 1 ? '' : 's'} past its horizon`;
}

/** How old the bundle is, said plainly, because an agent has to say it. */
export function bundleAgeLabel(ageHours: number | undefined): string {
	if (ageHours === undefined) return 'age unknown';
	if (ageHours < 1) return 'compiled within the hour';
	if (ageHours < 36) return `compiled ${Math.round(ageHours)} hours ago`;
	const days = Math.round(ageHours / 24);
	return `compiled ${days} day${days === 1 ? '' : 's'} ago`;
}

/** 0 to 1 as a percentage a person reads, with no false precision. */
export function confidencePct(confidence: number): string {
	return `${Math.round(confidence * 100)}%`;
}

/** The trust tier in words, because a bare 1 to 5 means nothing on a screen. */
export function trustLabel(tier: number): string {
	switch (tier) {
		case 5:
			return 'the ERP itself';
		case 4:
			return "the customer's own paperwork";
		case 3:
			return 'written correspondence';
		case 2:
			return 'somebody typed it';
		default:
			return 'an old export';
	}
}
