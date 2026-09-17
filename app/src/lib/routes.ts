/*
  Every address in the app, in one place.

  Before this, a URL was built wherever it was needed: nineteen anchors
  across the pages, two helpers in the catalog components, and nothing at
  all on the assistant's side, so a tool could return an account number but
  never a link to it. One of the customer links was also the only one that
  forgot encodeURIComponent.

  Two rules. A page builds its hrefs from here, and so does anything that
  returns a row to an agent, so a person and an agent are always given the
  same address for the same record.
*/

/** A record id that goes in a path segment, escaped once, here. */
const seg = (value: string | number): string => encodeURIComponent(String(value));

export const routes = {
	account: (customerNo: string) => `/accounts/${seg(customerNo)}`,
	accounts: () => '/accounts',
	commitment: (id: number) => `/commitments/${seg(id)}`,
	commitments: () => '/commitments',
	/** The closed-short question on one commitment. */
	commitmentAnswer: (id: number) => `/commitments/${seg(id)}#question`,
	part: (itemNo: string) => `/parts/${seg(itemNo)}`,
	parts: () => '/parts',
	vendor: (vendorNo: string) => `/vendors/${seg(vendorNo)}`,
	vendors: () => '/vendors',
	/** A quote request read out of a customer's email. */
	quoteRequest: (id: number) => `/rfq/${seg(id)}`,
	quote: (id: number) => `/quotes/${seg(id)}`,
	rule: (id: number) => `/automations/${seg(id)}`,
	conversation: (id: number) => `/ask/${seg(id)}`,
	deskMessage: (id: number) => `/desk/${seg(id)}`,
	/** The queue an agent's proposal waits in. */
	workspace: () => '/workspace',
	search: (q: string) => `/search?q=${encodeURIComponent(q)}`
} as const;
