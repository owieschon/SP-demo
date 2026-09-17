// The live mail provider: AgentMail.
//
// Only reachable when the server has AGENTMAIL_API_KEY. Everything else in the
// feature runs against the scripted mailbox (mock.ts), which is what the tests
// and public visitors get, so no test can ever reach this file.
//
// The SDK is loaded through a dynamic import of a specifier held in a
// variable, for two reasons: the package is only needed on a server that has
// a key, and the app still builds and type-checks on a machine where it is not
// installed. A missing package therefore degrades to a clear message instead
// of a build failure.
//
// Shapes are from the agentmail 0.5.26 SDK:
//   client.inboxes.messages.list(inboxId, { limit, labels })  metadata only
//   client.inboxes.messages.get(inboxId, messageId)           adds text/extractedText
//   client.inboxes.messages.send(inboxId, { to, cc, subject, text, attachments })
//   client.inboxes.messages.reply(inboxId, messageId, { text, attachments })
// A reply carries no subject of its own: the provider keeps the thread's.
import type { InboundMail, MailClient, OutboundMail, SentMail } from './mail.ts';

/** Just enough of the SDK's shape for what this file calls. */
interface SdkMessageItem {
	messageId: string;
	threadId: string;
	labels?: string[];
	timestamp?: Date | string;
	from: string;
	to?: string[];
	cc?: string[];
	subject?: string;
}

interface SdkMessage extends SdkMessageItem {
	text?: string;
	extractedText?: string;
	attachments?: {
		attachmentId: string;
		filename?: string;
		contentType?: string;
		size: number;
	}[];
}

interface SdkClient {
	inboxes: {
		messages: {
			list(inboxId: string, request?: { limit?: number; labels?: string[] }): Promise<{ messages: SdkMessageItem[] }>;
			get(inboxId: string, messageId: string): Promise<SdkMessage>;
			send(
				inboxId: string,
				request: {
					to?: string[];
					cc?: string[];
					subject?: string;
					text?: string;
					attachments?: { filename?: string; contentType?: string; content?: string }[];
				}
			): Promise<{ messageId: string; threadId: string }>;
			reply(
				inboxId: string,
				messageId: string,
				request: {
					to?: string[];
					cc?: string[];
					text?: string;
					attachments?: { filename?: string; contentType?: string; content?: string }[];
				}
			): Promise<{ messageId: string; threadId: string }>;
		};
	};
}

export class MailProviderError extends Error {
	/** True when trying again cannot help: a bad address, a refused body. */
	readonly permanent: boolean;

	constructor(message: string, permanent: boolean) {
		super(message);
		this.permanent = permanent;
	}
}

/**
 * "Name <user@host>" and "user@host" both give the address and, when it is
 * there, the name. The provider hands `from` over as one string.
 */
export function splitAddress(value: string): { address: string; name: string } {
	const match = value.match(/^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/);
	if (match) return { address: match[2].trim().toLowerCase(), name: match[1].replace(/^"|"$/g, '').trim() };
	return { address: value.trim().toLowerCase(), name: '' };
}

function asIso(value: Date | string | undefined): string {
	if (value instanceof Date) return value.toISOString();
	if (typeof value === 'string' && value.length > 0) return new Date(value).toISOString();
	return new Date().toISOString();
}

let cached: Promise<SdkClient> | null = null;

async function openClient(apiKey: string): Promise<SdkClient> {
	if (cached) return cached;
	// A variable specifier, so nothing resolves this package at build time.
	const specifier = 'agentmail';
	cached = import(/* @vite-ignore */ specifier)
		.then((module: { AgentMailClient?: new (options: { apiKey: string }) => SdkClient }) => {
			if (!module.AgentMailClient) {
				throw new MailProviderError('The agentmail package does not export AgentMailClient.', true);
			}
			return new module.AgentMailClient({ apiKey });
		})
		.catch((error: unknown) => {
			cached = null;
			if (error instanceof MailProviderError) throw error;
			throw new MailProviderError(
				`The agentmail package is not installed on this server, so live mail is off (${String(error)}).`,
				true
			);
		});
	return cached;
}

/** Anything the provider says that is worth telling a person, and whether a retry can help. */
function toProviderError(error: unknown): MailProviderError {
	if (error instanceof MailProviderError) return error;
	const status = (error as { statusCode?: number; status?: number }).statusCode ?? (error as { status?: number }).status;
	const message = (error as { message?: string }).message ?? String(error);
	// 4xx means the request itself was wrong, so sending it again will fail
	// again. Anything else (5xx, a timeout, no network) is worth a retry.
	const permanent = typeof status === 'number' && status >= 400 && status < 500;
	return new MailProviderError(`The mail provider ${permanent ? 'refused this' : 'could not be reached'}: ${message}`, permanent);
}

export function createAgentMailClient(apiKey: string): MailClient {
	return {
		kind: 'agentmail',
		label: 'AgentMail',

		async fetchNew(address, options): Promise<InboundMail[]> {
			const client = await openClient(apiKey);
			const limit = options?.limit ?? 10;
			let page: { messages: SdkMessageItem[] };
			try {
				page = await client.inboxes.messages.list(address, { limit, labels: ['received'] });
			} catch (error) {
				throw toProviderError(error);
			}

			// The list is metadata only, so each body is fetched on its own.
			const out: InboundMail[] = [];
			for (const item of page.messages.slice(0, limit)) {
				let full: SdkMessage;
				try {
					full = await client.inboxes.messages.get(address, item.messageId);
				} catch (error) {
					throw toProviderError(error);
				}
				const sender = splitAddress(full.from ?? item.from ?? '');
				const text = full.text ?? full.extractedText ?? '';
				out.push({
					providerMessageId: full.messageId,
					providerThreadId: full.threadId,
					from: sender.address,
					fromName: sender.name,
					to: (full.to ?? []).map((a) => splitAddress(a).address),
					cc: (full.cc ?? []).map((a) => splitAddress(a).address),
					subject: full.subject ?? '',
					text,
					// extractedText is the provider's reply-only body: quoted
					// history already taken off. It is optional, so fall back.
					strippedText: full.extractedText ?? text,
					receivedAt: asIso(full.timestamp ?? item.timestamp),
					attachments: (full.attachments ?? []).map((a) => ({
						providerAttachmentId: a.attachmentId,
						fileName: a.filename ?? 'attachment',
						mediaType: a.contentType ?? 'application/octet-stream',
						sizeBytes: a.size
						// The bytes live behind a short-lived signed URL. The desk
						// shows the name and hands parsing to the documents work,
						// so it does not download them here.
					}))
				});
			}
			return out;
		},

		async send(mail: OutboundMail): Promise<SentMail> {
			const client = await openClient(apiKey);
			const attachments = mail.attachments.map((a) => ({
				filename: a.fileName,
				contentType: a.mediaType,
				content: a.base64
			}));
			try {
				// Replying to the provider's own message id is what keeps the
				// thread together in the customer's mail client.
				const result = mail.inReplyToProviderId
					? await client.inboxes.messages.reply(mail.fromAddress, mail.inReplyToProviderId, {
							to: mail.to,
							cc: mail.cc.length > 0 ? mail.cc : undefined,
							text: mail.text,
							attachments: attachments.length > 0 ? attachments : undefined
						})
					: await client.inboxes.messages.send(mail.fromAddress, {
							to: mail.to,
							cc: mail.cc.length > 0 ? mail.cc : undefined,
							subject: mail.subject,
							text: mail.text,
							attachments: attachments.length > 0 ? attachments : undefined
						});
				return { providerMessageId: result.messageId, providerThreadId: result.threadId, simulated: false };
			} catch (error) {
				throw toProviderError(error);
			}
		}
	};
}
