// Reading an email as text: its headers, and which part of its body is the
// request that matters.
//
// A pasted email, a .txt file and a simple .eml file all arrive as text. This
// file does not try to be a full MIME parser (PDF and HTML-only mail are out
// of scope); it handles what people actually paste:
//   * headers at the top (From, To, Subject, Date), possibly folded,
//   * a forwarded email, where the real request sits below the forward line,
//   * a reply, where the new ask is on top and the old thread is quoted below,
//   * a signature, which names the sender's company and branch and is full of
//     phone numbers that must never be read as quantities.

export interface EmailHeaders {
	from: string | null;
	fromName: string | null;
	fromEmail: string | null;
	to: string | null;
	subject: string | null;
	/** The Date header as a calendar date (YYYY-MM-DD), when it can be read. */
	date: string | null;
}

export interface ParsedEmail {
	headers: EmailHeaders;
	/** The part of the body that holds the request (no quoted thread, no signature). */
	request: string;
	/** The signature block under the request, if one was found. */
	signature: string;
	/** True when the request came from below a forward line. */
	forwarded: boolean;
}

const HEADER = /^([A-Za-z][A-Za-z-]*):[ \t]*(.*)$/;

/** Split "Name <name@x.example>" into its parts. */
export function parseAddress(value: string | null): { name: string | null; email: string | null } {
	if (!value) return { name: null, email: null };
	const angled = value.match(/^\s*"?([^"<]*?)"?\s*<([^>\s]+@[^>\s]+)>/);
	if (angled) return { name: angled[1].trim() || null, email: angled[2].toLowerCase() };
	const bare = value.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
	return { name: null, email: bare ? bare[0].toLowerCase() : null };
}

const MONTHS: Record<string, number> = {
	jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12
};

/**
 * The calendar date of a Date header, as written (no time zone shift):
 * "Wed, 16 Sep 2026 09:12:00 -0500" -> 2026-09-16. Also reads "Sep 16, 2026"
 * and "2026-09-16", which forwarded headers often use.
 */
export function headerDate(value: string | null): string | null {
	if (!value) return null;
	const iso = value.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
	if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
	const dayFirst = value.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})\b/);
	const monthFirst = value.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/);
	let y: number, m: number | undefined, d: number;
	if (dayFirst && MONTHS[dayFirst[2].slice(0, 3).toLowerCase()]) {
		[y, m, d] = [Number(dayFirst[3]), MONTHS[dayFirst[2].slice(0, 3).toLowerCase()], Number(dayFirst[1])];
	} else if (monthFirst && MONTHS[monthFirst[1].slice(0, 3).toLowerCase()]) {
		[y, m, d] = [Number(monthFirst[3]), MONTHS[monthFirst[1].slice(0, 3).toLowerCase()], Number(monthFirst[2])];
	} else {
		return null;
	}
	return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Read a block of "Name: value" lines (folded lines continue the previous header). */
function readHeaderBlock(lines: string[]): Map<string, string> {
	const headers = new Map<string, string>();
	let last: string | null = null;
	for (const line of lines) {
		if (/^[ \t]+\S/.test(line) && last) {
			headers.set(last, `${headers.get(last)} ${line.trim()}`);
			continue;
		}
		const m = line.match(HEADER);
		if (!m) continue;
		last = m[1].toLowerCase();
		if (!headers.has(last)) headers.set(last, m[2].trim());
	}
	return headers;
}

function toHeaders(map: Map<string, string>): EmailHeaders {
	const from = map.get('from') ?? null;
	const address = parseAddress(from);
	return {
		from,
		fromName: address.name,
		fromEmail: address.email,
		to: map.get('to') ?? null,
		subject: map.get('subject') ?? null,
		date: headerDate(map.get('date') ?? map.get('sent') ?? null)
	};
}

/** Undo quoted-printable encoding (=20, soft line breaks), which some .eml files use. */
function decodeQuotedPrintable(text: string): string {
	return text
		.replace(/=\r?\n/g, '')
		.replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * For a multipart .eml, keep the first text/plain part. Anything else
 * (HTML-only mail, attachments) is out of scope and left as is.
 */
function plainTextBody(headerMap: Map<string, string>, body: string): string {
	const type = headerMap.get('content-type') ?? '';
	const boundary = type.match(/boundary="?([^";]+)"?/i)?.[1];
	if (boundary && /multipart/i.test(type)) {
		for (const part of body.split(`--${boundary}`)) {
			const split = part.replace(/^\r?\n/, '').split(/\r?\n\r?\n/);
			const partHeaders = readHeaderBlock(split[0].split(/\r?\n/));
			if (/text\/plain/i.test(partHeaders.get('content-type') ?? '')) {
				const text = split.slice(1).join('\n\n');
				return /quoted-printable/i.test(partHeaders.get('content-transfer-encoding') ?? '')
					? decodeQuotedPrintable(text)
					: text;
			}
		}
	}
	if (/quoted-printable/i.test(headerMap.get('content-transfer-encoding') ?? '')) {
		return decodeQuotedPrintable(body);
	}
	return body;
}

const FORWARD_LINE = /^\s*(?:-{2,}\s*Forwarded message\s*-{2,}|Begin forwarded message:?|-{2,}\s*Forwarded by)/i;
const REPLY_LINE = /^\s*(?:On\b.{4,120}\bwrote:\s*$|-{2,}\s*Original Message\s*-{2,}|_{8,}\s*$)/i;
// Outlook replies quote the old message under a "From: ... Sent: ..." block.
const OUTLOOK_REPLY = /^\s*From:\s.+$/i;
const SIGNATURE_START = /^\s*(?:--\s*|-- ?|thanks[,!.]?|thank you[,!.]?|thx[,!.]?|regards[,!.]?|best regards[,!.]?|best[,!.]?|sincerely[,!.]?|cheers[,!.]?)\s*$/i;

/** Remove the quoted thread under a reply, and ">" lines anywhere. */
function stripQuoted(lines: string[]): string[] {
	const kept: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (REPLY_LINE.test(line)) break;
		// "From: x" followed within two lines by "Sent:" or "Date:" is an Outlook quote.
		if (OUTLOOK_REPLY.test(line) && lines.slice(i + 1, i + 3).some((l) => /^\s*(Sent|Date):/i.test(l))) break;
		if (/^\s*>/.test(line)) continue;
		kept.push(line);
	}
	return kept;
}

/** Split a block of text into the message and its signature. */
function splitSignature(lines: string[]): { body: string[]; signature: string[] } {
	// Search from the end of the text for the sign-off, so a "Thanks" early in
	// the message does not cut off the request.
	for (let i = lines.length - 1; i >= 0; i--) {
		if (SIGNATURE_START.test(lines[i])) {
			return { body: lines.slice(0, i), signature: lines.slice(i + 1) };
		}
	}
	return { body: lines, signature: [] };
}

export function parseEmail(source: string): ParsedEmail {
	const text = source.replace(/\r\n?/g, '\n').replace(/^﻿/, '');
	const lines = text.split('\n');

	// Headers only count when the text starts with them.
	let bodyStart = 0;
	let headerMap = new Map<string, string>();
	if (HEADER.test(lines[0] ?? '')) {
		const blank = lines.findIndex((l) => l.trim() === '');
		const end = blank === -1 ? lines.length : blank;
		headerMap = readHeaderBlock(lines.slice(0, end));
		bodyStart = end + 1;
	}
	const headers = toHeaders(headerMap);
	const body = plainTextBody(headerMap, lines.slice(bodyStart).join('\n')).split('\n');

	// A forward: the forwarder's note is on top, the customer's email below.
	const forwardAt = body.findIndex((l) => FORWARD_LINE.test(l));
	if (forwardAt !== -1) {
		const note = stripQuoted(body.slice(0, forwardAt));
		const below = body.slice(forwardAt + 1);
		// The forwarded email starts with its own header block.
		let i = 0;
		while (i < below.length && below[i].trim() === '') i++;
		const headerLines: string[] = [];
		while (i < below.length && (HEADER.test(below[i]) || /^[ \t]+\S/.test(below[i]))) {
			headerLines.push(below[i]);
			i++;
		}
		const inner = toHeaders(readHeaderBlock(headerLines));
		const innerSplit = splitSignature(stripQuoted(below.slice(i)));
		return {
			headers: {
				...headers,
				// The customer is whoever sent the forwarded email.
				from: inner.from ?? headers.from,
				fromName: inner.fromName ?? headers.fromName,
				fromEmail: inner.fromEmail ?? headers.fromEmail,
				subject: inner.subject ?? headers.subject,
				// Relative dates ("by Friday") count from when the customer wrote.
				date: inner.date ?? headers.date
			},
			request: [...note, ...innerSplit.body].join('\n').trim(),
			signature: innerSplit.signature.join('\n').trim(),
			forwarded: true
		};
	}

	const split = splitSignature(stripQuoted(body));
	return {
		headers,
		request: split.body.join('\n').trim(),
		signature: split.signature.join('\n').trim(),
		forwarded: false
	};
}
