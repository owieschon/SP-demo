/*
  Every address the overview hands out, in one place.

  The rule this page is built to is that every number on it is a link and the
  chain does not break: aggregate, then segment, then the record, then the
  evidence that produced the number. That only holds if there is exactly one
  place that knows what each link is, so the server builds every href here and
  puts it in the payload. Nothing downstream concatenates a URL: the page and
  the components render `row.href`, and the tests assert these functions.

  Addresses that already exist come from $lib/routes, including their filters,
  so a link lands on a real filtered view and not a page that ignores the
  query string. The ones this feature owns live under /overview.
*/
import { routes } from '$lib/routes';

/** The three leaks, as they appear in a URL. */
export const LEAKS = ['price-exceptions', 'freight', 'cost-passthrough'] as const;
export type LeakId = (typeof LEAKS)[number];

/** The risk topics this feature has a page for. The rest link to existing screens. */
export const RISK_TOPICS = ['late-supply'] as const;
export type RiskTopic = (typeof RISK_TOPICS)[number];

/** `?a=1&b=2`, or '' when there is nothing to add. Encoded once, here. */
function query(params: Record<string, string | number | undefined | null>): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value === undefined || value === null || value === '') continue;
		search.set(key, String(value));
	}
	const text = search.toString();
	return text ? `?${text}` : '';
}

export const links = {
	/** The overview itself. */
	overview: () => '/overview',

	// ------------------------------------------------ 1. where the money is

	/** Revenue and margin by month. `month` opens one month, `customer` its lines. */
	revenue: (options: { month?: string; customer?: string } = {}) =>
		`/overview/revenue${query({ month: options.month, customer: options.customer })}`,

	/** One named leak: its segments. `key` opens the evidence behind one segment. */
	leak: (leak: LeakId, key?: string) => `/overview/leak/${leak}${query({ key })}`,

	// -------------------------------------------------- 2. our own promises

	/** Commitment windows by outcome. `customer` narrows it to one account. */
	promises: (options: { outcome?: 'kept' | 'pushed' | 'broken'; customer?: string } = {}) =>
		`/overview/promises${query({ outcome: options.outcome, customer: options.customer })}`,

	/** The commitment board, as the board itself filters it. */
	commitments: (who?: 'mine' | 'all') => routes.commitments(who),
	commitment: (id: number) => routes.commitment(id),

	/*
	  Emailed quote requests, and one of them. The list of them is the order
	  desk itself since the upload page was retired: a quote request is
	  something the desk handled, not a screen of its own.
	*/
	quoteRequests: () => routes.desk(),
	quoteRequest: (id: number) => routes.quoteRequest(id),
	quote: (id: number) => routes.quote(id),

	// --------------------------------------------------------- 3. the agents

	/*
	  The run feed. Every filter here is one nl.agent_run_log can take. The
	  names are nullable because a caller usually passes the filters it was
	  given, and "no agent" arrives as null from a query string.
	*/
	runs: (
		options: {
			agent?: string | null;
			workKind?: string | null;
			refused?: boolean;
			acted?: boolean;
		} = {}
	) =>
		`/overview/runs${query({
			agent: options.agent,
			work: options.workKind,
			refused: options.refused ? '1' : undefined,
			acted: options.acted ? '1' : undefined
		})}`,

	/** One run: what it read, what it decided, what it was refused. */
	run: (runKey: string) => `/overview/runs/${encodeURIComponent(runKey)}`,

	/** Where a person decides an agent's proposal. */
	queue: (source?: 'rfq' | 'assistant' | 'mail' | 'purchase') => routes.workspace(source),

	/** What the agents may do on their own. */
	autonomy: () => routes.settings(),

	// ----------------------------------------------------- 4. what is at risk

	/** Open order lines the forecast cannot supply. A real filter on a real page. */
	noSupply: () => `${routes.forecast()}${query({ status: 'no_supply', who: 'all' })}`,
	/** Open lines whose own supply is already overdue. */
	lateSupply: () => `${routes.forecast()}${query({ status: 'late_supply_overdue', who: 'all' })}`,
	/** Every open line that will miss the date we gave. */
	late: () => `${routes.forecast()}${query({ status: 'late', who: 'all' })}`,
	/** Purchase and production orders past their own due date. */
	riskTopic: (topic: RiskTopic) => `/overview/risk/${topic}`,
	/** What nobody is answerable for. `kind` opens one of the three lists. */
	coverage: (kind?: 'account' | 'part_family' | 'mailbox') => `/overview/coverage${query({ kind })}`,
	/** Who may decide what, and up to how much. */
	people: () => '/people',
	/** The accounts list, filtered to the ones that have gone quiet, longest first. */
	quietAccounts: () => `${routes.accounts()}${query({ quiet: '1', sort: 'quiet', who: 'all' })}`,

	// ----------------------------------------------------------- the records

	account: (customerNo: string) => routes.account(customerNo),
	part: (itemNo: string) => routes.part(itemNo),
	vendor: (vendorNo: string) => routes.vendor(vendorNo)
};
