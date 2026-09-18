/*
  Every address in the app, in one place.

  Before this, a URL was built wherever it was needed: nineteen anchors
  across the pages, two helpers in the catalog components, and nothing at
  all on the assistant's side, so a tool could return an account number but
  never a link to it. One of the customer links was also the only one that
  forgot encodeURIComponent.

  Two rules. A page builds its hrefs from here, and so does anything that
  returns a row to an agent, so a person and an agent are always given the
  same address for the same record. The rail (nav.ts) and the command
  palette build theirs from here too.
*/

/** A record id that goes in a path segment, escaped once, here. */
const seg = (value: string | number): string => encodeURIComponent(String(value));

export const routes = {
	/** The exception queue: what needs a person right now. */
	today: () => '/',
	account: (customerNo: string) => `/accounts/${seg(customerNo)}`,
	accounts: () => '/accounts',
	commitment: (id: number) => `/commitments/${seg(id)}`,
	commitments: (who?: 'mine' | 'all') => (who ? `/commitments?who=${who}` : '/commitments'),
	/** The closed-short question on one commitment. */
	commitmentAnswer: (id: number) => `/commitments/${seg(id)}#question`,
	/** The next closed-short question, whichever commitment it is on. */
	commitmentsAnswer: (who?: 'mine' | 'all') =>
		who ? `/commitments/answer?who=${who}` : '/commitments/answer',
	part: (itemNo: string) => `/parts/${seg(itemNo)}`,
	parts: () => '/parts',
	vendor: (vendorNo: string) => `/vendors/${seg(vendorNo)}`,
	vendors: () => '/vendors',
	/** A quote request read out of a customer's email. */
	quoteRequest: (id: number) => `/rfq/${seg(id)}`,
	/** Where emailed requests arrive. */
	quoteRequests: () => '/rfq',
	quote: (id: number) => `/quotes/${seg(id)}`,
	rule: (id: number) => `/automations/${seg(id)}`,
	rules: () => '/automations',
	newRule: () => '/automations/new',
	conversation: (id: number) => `/ask/${seg(id)}`,
	ask: () => '/ask',
	deskMessage: (id: number) => `/desk/${seg(id)}`,
	desk: () => '/desk',
	/** The queue an agent's proposal waits in. */
	workspace: (source?: 'rfq' | 'assistant' | 'mail' | 'purchase') =>
		source ? `/workspace?source=${source}` : '/workspace',
	/** What the agents did, and what a person decided about it. */
	workspaceDecisions: () => '/workspace#decided',
	operations: () => '/operations',
	forecast: () => '/operations/forecast',
	warehouse: (itemNo?: string) => (itemNo ? `/warehouse?part=${seg(itemNo)}` : '/warehouse'),
	settings: () => '/settings',
	settingsMcp: () => '/settings/mcp',
	signin: () => '/signin',
	/** Who is responsible for what, what they may approve, and what they may see. */
	people: () => '/people',
	/** What each agent did, what it refused, and how far it may go on its own. */
	agents: (agent?: string) => (agent ? `/agents?agent=${encodeURIComponent(agent)}` : '/agents'),
	/**
	 * One eval case, as the file itself. `suite` is the CASE FOLDER, which is
	 * what EvalSuite.folder carries: the desk suite is reported as "order desk"
	 * and keeps its cases in `desk`.
	 */
	agentEvalCase: (suite: string, name: string) => `/agents/evals/${seg(suite)}/${seg(name)}`,
	search: (q?: string) => (q ? `/search?q=${encodeURIComponent(q)}` : '/search')
} as const;
