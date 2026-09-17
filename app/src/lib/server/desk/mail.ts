// The mail provider, behind one small interface.
//
// Two implementations sit behind it: the scripted mailbox (mock.ts), which is
// what the tests and every public visitor get, and AgentMail (agentmail.ts),
// which is only reachable when the server has a key. Nothing above this file
// knows which one it is talking to, and nothing in the tests can reach the
// real one: the client is chosen from the environment in one function, and
// the tests pass their own.
export interface InboundAttachment {
	providerAttachmentId: string | null;
	fileName: string;
	mediaType: string;
	sizeBytes: number;
	/** Base64, when the provider handed the bytes over. */
	base64?: string;
}

export interface InboundMail {
	providerMessageId: string | null;
	providerThreadId: string | null;
	from: string;
	fromName: string;
	to: string[];
	cc: string[];
	subject: string;
	/** The whole body as text. HTML is never rendered anywhere in this feature. */
	text: string;
	/** The body with quoted history taken off, when the provider gives us one. */
	strippedText: string;
	receivedAt: string;
	attachments: InboundAttachment[];
}

export interface OutboundMail {
	/** The mailbox address it goes out from. */
	fromAddress: string;
	to: string[];
	cc: string[];
	subject: string;
	text: string;
	/** Reply to this provider message, which keeps the thread together. */
	inReplyToProviderId: string | null;
	attachments: { fileName: string; mediaType: string; base64: string }[];
}

export interface SentMail {
	providerMessageId: string;
	providerThreadId: string | null;
	/** True when nothing left the building, because there is no key. */
	simulated: boolean;
}

export interface MailClient {
	readonly kind: 'mock' | 'agentmail';
	/** What the page calls it. The scripted one says so plainly. */
	readonly label: string;
	/** New mail for one mailbox address. Duplicates are fine: the database drops them. */
	fetchNew(address: string, options?: { limit?: number }): Promise<InboundMail[]>;
	send(mail: OutboundMail): Promise<SentMail>;
}

/** The one line a person sees when the provider is the scripted one. */
export const MOCK_LABEL = 'scripted demo mailbox';
