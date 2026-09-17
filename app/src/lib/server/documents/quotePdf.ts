// The quote as a real PDF, drawn with pdf-lib.
//
// No browser and no native module: pdf-lib writes the file itself and the
// four standard fonts are named in the document rather than embedded, so
// this runs in a plain Node function and the whole quote comes to a few
// kilobytes.
//
// It takes a QuoteDoc (see quote.ts) and draws it. It works nothing out, so
// the PDF cannot disagree with the page: both show the same object.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { DEMO_FOOTER, LETTERHEAD } from './letterhead.ts';
import type { QuoteDoc } from './quote.ts';

// US Letter, in points.
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

// Ink. Near-black rather than black, and one grey, which is all a quote needs.
const INK = rgb(0.1, 0.11, 0.12);
const GREY = rgb(0.42, 0.44, 0.47);
const HAIRLINE = rgb(0.82, 0.83, 0.85);

/** The columns of the line table: label, x offset, width, and alignment. */
const COLUMNS = [
	{ label: 'Line', x: 0, width: 26, align: 'left' as const },
	{ label: 'Part number', x: 26, width: 92, align: 'left' as const },
	{ label: 'Description', x: 118, width: 190, align: 'left' as const },
	{ label: 'Qty', x: 308, width: 40, align: 'right' as const },
	{ label: 'Unit price', x: 348, width: 72, align: 'right' as const },
	{ label: 'Extended', x: 420, width: 84, align: 'right' as const }
];

const money = new Intl.NumberFormat('en-US', {
	style: 'currency',
	currency: 'USD',
	minimumFractionDigits: 2,
	maximumFractionDigits: 2
});

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-10-17' -> 'Oct 17, 2026'. Calendar dates only, never shifted. */
export function longDay(iso: string): string {
	const [y, m, d] = iso.split('-').map(Number);
	return `${MONTHS[m - 1]} ${d}, ${y}`;
}

// Characters the standard fonts cannot write, and what to write instead.
// Listed by code point rather than typed in, so this file stays plain ASCII:
// a curly quote in the source of the thing that replaces curly quotes is a
// joke waiting to happen.
const FOLDED: [number[], string][] = [
	[[0x2018, 0x2019, 0x201b], "'"],
	[[0x201c, 0x201d], '"'],
	[[0x2013, 0x2014, 0x2212], '-'],
	[[0x2026], '...'],
	[[0x00a0, 0x2007, 0x202f], ' ']
];

/**
 * The standard fonts can only write the characters of one old code page, so
 * anything outside it would make pdf-lib throw while saving. Curly quotes and
 * dashes become their plain equivalents, and anything still out of range is
 * dropped rather than allowed to break the file.
 */
export function sanitize(text: string): string {
	let out = '';
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		const folded = FOLDED.find(([codes]) => codes.includes(code));
		if (folded) {
			out += folded[1];
		} else if (code >= 32 && code <= 255) {
			out += ch;
		}
		// Anything else is dropped: a missing glyph beats a file that will
		// not save.
	}
	return out;
}

/** Cut text to a width, with an ellipsis, so a long description cannot spill. */
function fit(text: string, font: PDFFont, size: number, width: number): string {
	const clean = sanitize(text);
	if (font.widthOfTextAtSize(clean, size) <= width) return clean;
	let cut = clean;
	while (cut.length > 1 && font.widthOfTextAtSize(`${cut}...`, size) > width) {
		cut = cut.slice(0, -1);
	}
	return `${cut.trimEnd()}...`;
}

/** Break text into lines that each fit a width. */
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
	const words = sanitize(text).split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let line = '';
	for (const word of words) {
		const candidate = line === '' ? word : `${line} ${word}`;
		if (font.widthOfTextAtSize(candidate, size) <= width) {
			line = candidate;
		} else {
			if (line !== '') lines.push(line);
			line = word;
		}
	}
	if (line !== '') lines.push(line);
	return lines;
}

interface Ink {
	page: PDFPage;
	regular: PDFFont;
	bold: PDFFont;
}

function text(
	ink: Ink,
	value: string,
	options: { x: number; y: number; size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; width?: number; align?: 'left' | 'right' }
): void {
	const size = options.size ?? 9.5;
	const font = options.bold ? ink.bold : ink.regular;
	const shown = options.width === undefined ? sanitize(value) : fit(value, font, size, options.width);
	const x =
		options.align === 'right' && options.width !== undefined
			? options.x + options.width - font.widthOfTextAtSize(shown, size)
			: options.x;
	ink.page.drawText(shown, { x, y: options.y, size, font, color: options.color ?? INK });
}

function rule(page: PDFPage, y: number, color = HAIRLINE, width = CONTENT_WIDTH, x = MARGIN): void {
	page.drawLine({ start: { x, y }, end: { x: x + width, y }, thickness: 0.6, color });
}

/** The letterhead and the quote's own facts, at the top of the first page. */
function drawHead(ink: Ink, doc: QuoteDoc): number {
	let y = PAGE_HEIGHT - MARGIN;

	text(ink, LETTERHEAD.company, { x: MARGIN, y: y - 14, size: 17, bold: true });
	text(ink, LETTERHEAD.tagline, { x: MARGIN, y: y - 27, size: 8.5, color: GREY });
	text(ink, LETTERHEAD.street, { x: MARGIN, y: y - 41, size: 8.5, color: GREY });
	text(ink, LETTERHEAD.town, { x: MARGIN, y: y - 52, size: 8.5, color: GREY });
	text(ink, `${LETTERHEAD.phone} · ${LETTERHEAD.email}`, { x: MARGIN, y: y - 63, size: 8.5, color: GREY });

	// The quote's own block, right aligned against the margin.
	const right = MARGIN + CONTENT_WIDTH;
	const blockWidth = 200;
	const blockX = right - blockWidth;
	text(ink, doc.kind === 'quote' ? 'QUOTE' : 'DRAFT QUOTE', {
		x: blockX,
		y: y - 14,
		size: 17,
		bold: true,
		width: blockWidth,
		align: 'right'
	});
	const facts: [string, string][] = [
		[doc.kind === 'quote' ? 'Quote number' : 'Request', doc.reference],
		['Date', longDay(doc.quotedOn)],
		['Valid until', doc.validUntil ? longDay(doc.validUntil) : 'on request']
	];
	if (doc.commitmentId !== null) facts.push(['Commitment', `C-${doc.commitmentId}`]);
	facts.forEach(([label, value], i) => {
		const lineY = y - 30 - i * 11;
		text(ink, label, { x: blockX, y: lineY, size: 8.5, color: GREY, width: 92, align: 'right' });
		text(ink, value, { x: blockX + 96, y: lineY, size: 8.5, bold: true, width: blockWidth - 96, align: 'right' });
	});

	y -= 78;
	rule(ink.page, y);
	y -= 18;

	// Who it is for.
	text(ink, 'Quoted to', { x: MARGIN, y, size: 8, color: GREY });
	text(ink, 'Prepared by', { x: MARGIN + 300, y, size: 8, color: GREY });
	y -= 13;
	text(ink, doc.customerName, { x: MARGIN, y, size: 11, bold: true, width: 290 });
	text(ink, doc.preparedBy, { x: MARGIN + 300, y, size: 11, bold: true, width: 200 });
	y -= 12;
	const where = [doc.customerCity, doc.customerState].filter(Boolean).join(', ');
	text(ink, `Account ${doc.customerNo}${where ? ` · ${where}` : ''}`, { x: MARGIN, y, size: 8.5, color: GREY, width: 290 });
	text(ink, `${LETTERHEAD.company} · ${LETTERHEAD.phone}`, { x: MARGIN + 300, y, size: 8.5, color: GREY, width: 200 });
	y -= 12;
	if (doc.buyerName) {
		const buyer = [doc.buyerName, doc.buyerTitle].filter(Boolean).join(', ');
		text(ink, `Attention: ${buyer}${doc.buyerEmail ? ` · ${doc.buyerEmail}` : ''}`, {
			x: MARGIN,
			y,
			size: 8.5,
			color: GREY,
			width: 290
		});
	}
	text(ink, `Price group: ${doc.priceGroupLabel}`, { x: MARGIN + 300, y, size: 8.5, color: GREY, width: 200 });
	return y - 22;
}

/** The table's header row. Drawn again at the top of every later page. */
function drawTableHead(ink: Ink, y: number): number {
	for (const column of COLUMNS) {
		text(ink, column.label, {
			x: MARGIN + column.x,
			y,
			size: 8,
			bold: true,
			color: GREY,
			width: column.width,
			align: column.align
		});
	}
	rule(ink.page, y - 6);
	return y - 20;
}

function drawFooter(ink: Ink, page: number, pages: number): void {
	rule(ink.page, MARGIN + 26);
	text(ink, DEMO_FOOTER, { x: MARGIN, y: MARGIN + 14, size: 7.5, color: GREY, width: CONTENT_WIDTH - 60 });
	text(ink, `Page ${page} of ${pages}`, {
		x: MARGIN + CONTENT_WIDTH - 60,
		y: MARGIN + 14,
		size: 7.5,
		color: GREY,
		width: 60,
		align: 'right'
	});
}

/** The quote as PDF bytes. */
export async function quotePdf(doc: QuoteDoc): Promise<Uint8Array> {
	const pdf = await PDFDocument.create();
	const regular = await pdf.embedFont(StandardFonts.Helvetica);
	const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

	pdf.setTitle(`${doc.title} · ${LETTERHEAD.company}`);
	pdf.setSubject(`Quote for ${doc.customerName} (account ${doc.customerNo})`);
	pdf.setAuthor(LETTERHEAD.company);
	pdf.setCreator(`${LETTERHEAD.company} sales and operations app (portfolio demo, invented data)`);
	pdf.setProducer('pdf-lib');

	const pages: PDFPage[] = [];
	const newPage = () => {
		const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
		pages.push(page);
		return page;
	};

	let ink: Ink = { page: newPage(), regular, bold };
	let y = drawHead(ink, doc);
	y = drawTableHead(ink, y);

	/** Where a page must stop: the footer, plus room for the totals block. */
	const floor = MARGIN + 52;

	for (const line of doc.lines) {
		if (y < floor + 30) {
			ink = { page: newPage(), regular, bold };
			y = PAGE_HEIGHT - MARGIN - 14;
			text(ink, `${doc.title}, continued`, { x: MARGIN, y, size: 9, color: GREY });
			y = drawTableHead(ink, y - 16);
		}
		const cells = [
			String(line.lineNo),
			line.itemNo,
			line.description,
			String(line.quantity),
			money.format(line.unitPrice),
			money.format(line.extended)
		];
		COLUMNS.forEach((column, i) => {
			text(ink, cells[i], {
				x: MARGIN + column.x,
				y,
				size: 9.5,
				width: column.width,
				align: column.align,
				bold: i === 1
			});
		});
		y -= 15;
	}

	// The totals block sits under the last line, on a new page if it has to.
	if (y < floor + 66) {
		ink = { page: newPage(), regular, bold };
		y = PAGE_HEIGHT - MARGIN - 20;
	}
	y -= 4;
	rule(ink.page, y + 8);
	const totalX = MARGIN + COLUMNS[4].x;
	const totalWidth = COLUMNS[4].width + COLUMNS[5].width;
	text(ink, 'Subtotal', { x: totalX, y: y - 8, size: 10, bold: true, width: COLUMNS[4].width, align: 'right' });
	text(ink, money.format(doc.subtotal), {
		x: MARGIN + COLUMNS[5].x,
		y: y - 8,
		size: 10,
		bold: true,
		width: COLUMNS[5].width,
		align: 'right'
	});
	text(ink, `${doc.lines.length} ${doc.lines.length === 1 ? 'line' : 'lines'}`, {
		x: MARGIN,
		y: y - 8,
		size: 8.5,
		color: GREY,
		width: 200
	});
	y -= 26;

	for (const paragraph of [doc.freightNote, doc.terms]) {
		for (const wrapped of wrap(paragraph, regular, 8.5, totalWidth + 120)) {
			text(ink, wrapped, { x: MARGIN, y, size: 8.5, color: GREY });
			y -= 11;
		}
		y -= 3;
	}

	if (doc.kind === 'draft') {
		text(ink, 'This is a draft. It has not been approved and no order has been entered.', {
			x: MARGIN,
			y,
			size: 8.5,
			bold: true,
			width: CONTENT_WIDTH
		});
	}

	pages.forEach((page, i) => drawFooter({ page, regular, bold }, i + 1, pages.length));

	return pdf.save();
}

/** The file name a download gets: quote-448123.pdf, or quote-draft-R-7001.pdf. */
export function quoteFileName(doc: QuoteDoc): string {
	return doc.kind === 'quote' ? `northline-quote-${doc.reference}.pdf` : `northline-draft-quote-${doc.reference}.pdf`;
}
