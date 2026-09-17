/*
  Every address in the app, in one place.

  Before this, each page and each component built its own hrefs by hand, and
  one of them (the warehouse pick queue) forgot to encode a customer number.
  A single registry means a page, a search result and the command palette
  cannot disagree about where a record lives.
*/

const enc = encodeURIComponent;

export const routes = {
	today: () => '/',
	commitments: (who?: 'mine' | 'all') => (who ? `/commitments?who=${who}` : '/commitments'),
	commitment: (id: number) => `/commitments/${id}`,
	commitmentsAnswer: (who?: 'mine' | 'all') =>
		who ? `/commitments/answer?who=${who}` : '/commitments/answer',
	accounts: () => '/accounts',
	account: (customerNo: string) => `/accounts/${enc(customerNo)}`,
	parts: () => '/parts',
	part: (itemNo: string) => `/parts/${enc(itemNo)}`,
	vendors: () => '/vendors',
	vendor: (vendorNo: string) => `/vendors/${enc(vendorNo)}`,
	search: (q?: string) => (q ? `/search?q=${enc(q)}` : '/search'),
	operations: () => '/operations',
	forecast: () => '/operations/forecast',
	warehouse: (itemNo?: string) => (itemNo ? `/warehouse?part=${enc(itemNo)}` : '/warehouse'),
	automations: () => '/automations',
	automationNew: () => '/automations/new',
	automation: (id: number) => `/automations/${id}`,
	rfq: () => '/rfq',
	rfqDraft: (id: number) => `/rfq/${id}`,
	quote: (id: number) => `/quotes/${id}`,
	ask: () => '/ask',
	conversation: (id: number) => `/ask/${id}`,
	desk: () => '/desk',
	deskMessage: (id: number) => `/desk/${id}`,
	workspace: (source?: 'rfq' | 'assistant' | 'mail' | 'purchase') =>
		source ? `/workspace?source=${source}` : '/workspace',
	/** What the agents did and what a person decided about it. */
	workspaceDecisions: () => '/workspace#decisions',
	settings: () => '/settings',
	settingsMcp: () => '/settings/mcp',
	signin: () => '/signin'
} as const;
