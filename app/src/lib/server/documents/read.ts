// The one door into this folder: bytes in, parsed documents out.
//
// What arrives from the intake form is a paste box and zero or more files.
// This file decides what each file really is, refuses what it will not read,
// hands the rest to the right reader, and returns both the parsed documents
// and the bytes to store.
//
// What a file is called is never trusted on its own. The first bytes of a
// file say what it is, and a name and a signature that disagree are refused:
// that is what stops a program from being stored as a .txt, and it is why
// the media type served on the way back out is chosen from the signature
// here and not from what the browser claimed (see MEDIA_TYPES).
import { createHash } from 'node:crypto';
import { readCsvDocument } from './csv.ts';
import { readPdfDocument } from './pdf.ts';
import { readSpreadsheetDocument } from './spreadsheet.ts';
import { readTextDocument } from './text.ts';
import {
	DocumentError,
	MAX_FILES,
	MAX_FILE_BYTES,
	MEDIA_TYPES,
	type ParsedDocument,
	type StoredKind
} from './types.ts';

/** The file extensions the intake form accepts, for the input's accept list. */
export const ACCEPTED_EXTENSIONS = ['.txt', '.eml', '.pdf', '.xlsx', '.xls', '.csv'] as const;

const startsWith = (bytes: Uint8Array, signature: number[]): boolean =>
	signature.every((byte, i) => bytes[i] === byte);

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // %PDF
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // PK.. (an .xlsx is a zip)
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]; // an old .xls, and a .msg
const EXE_MAGIC = [0x4d, 0x5a]; // MZ, a Windows program
const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46]; // a Linux program

function extensionOf(name: string): string {
	const dot = name.lastIndexOf('.');
	return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

/**
 * What this file is, from its name and its first bytes together. Throws a
 * DocumentError naming the reason when the two disagree, when the format is
 * not one we read, or when the bytes are a program.
 */
export function kindOfFile(name: string, bytes: Uint8Array): StoredKind {
	const extension = extensionOf(name);

	if (startsWith(bytes, EXE_MAGIC) || startsWith(bytes, ELF_MAGIC)) {
		throw new DocumentError(`${name} is a program, not a document. It was not read and nothing was stored.`);
	}
	if (extension === '.msg') {
		throw new DocumentError(
			`${name} is an Outlook .msg file, which this app does not read. In Outlook use File then Save As and pick Text Only, or forward the message and paste it.`
		);
	}

	if (extension === '.pdf') {
		if (!startsWith(bytes, PDF_MAGIC)) {
			throw new DocumentError(`${name} is named like a PDF but it is not one. Ask for it again.`);
		}
		return 'pdf';
	}
	if (extension === '.xlsx') {
		if (!startsWith(bytes, ZIP_MAGIC)) {
			throw new DocumentError(`${name} is named like a spreadsheet but it is not one. Open it and save it again as .xlsx.`);
		}
		return 'xlsx';
	}
	if (extension === '.xls') {
		// The old format is an OLE container; plenty of systems also export a
		// modern .xlsx or a zip under the .xls name, and SheetJS reads both.
		if (startsWith(bytes, ZIP_MAGIC)) return 'xlsx';
		if (!startsWith(bytes, OLE_MAGIC)) {
			throw new DocumentError(`${name} is named like a spreadsheet but it is not one. Open it and save it again as .xlsx.`);
		}
		return 'xls';
	}

	// The text formats have no signature, so the check is the other way
	// round: it must not be one of the binary ones.
	if (extension === '.csv' || extension === '.txt' || extension === '.eml') {
		for (const [magic, what] of [
			[PDF_MAGIC, 'a PDF'],
			[ZIP_MAGIC, 'a zip or a spreadsheet'],
			[OLE_MAGIC, 'an old Office file']
		] as const) {
			if (startsWith(bytes, magic)) {
				throw new DocumentError(`${name} is named like text but it is ${what}. Rename it and try again.`);
			}
		}
		if (extension === '.csv') return 'csv';
		return extension === '.txt' ? 'txt' : 'eml';
	}

	throw new DocumentError(
		`${name} is not a kind of file this app reads. Send a .txt, .eml, .pdf, .xlsx, .xls or .csv, or paste the text.`
	);
}

/** The bytes to store for one file, alongside what was read out of it. */
export interface StoredFile {
	ordinal: number;
	fileName: string;
	kind: StoredKind;
	mediaType: string;
	bytes: Uint8Array;
	sha256: string;
	byteSize: number;
	pageCount: number | null;
	sheetCount: number | null;
	rowCount: number | null;
	summary: string;
}

export function sha256Of(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

/** One uploaded file, read. Throws DocumentError with the reason. */
export async function readUploadedFile(
	file: File,
	ordinal: number
): Promise<{ doc: ParsedDocument; stored: StoredFile }> {
	const name = file.name || `attachment ${ordinal}`;
	if (file.size === 0) throw new DocumentError(`${name} is empty.`);
	if (file.size > MAX_FILE_BYTES) {
		const mb = (file.size / (1024 * 1024)).toFixed(1);
		throw new DocumentError(`${name} is ${mb} MB, and the most one file can be is 10 MB.`);
	}

	const bytes = new Uint8Array(await file.arrayBuffer());
	// The browser's own size can differ from what actually arrived.
	if (bytes.byteLength > MAX_FILE_BYTES) {
		throw new DocumentError(`${name} is larger than 10 MB.`);
	}
	const kind = kindOfFile(name, bytes);

	let doc: ParsedDocument;
	if (kind === 'pdf') {
		doc = await readPdfDocument({ name, attachment: ordinal, bytes });
	} else if (kind === 'xlsx' || kind === 'xls') {
		doc = readSpreadsheetDocument({ kind, name, attachment: ordinal, bytes });
	} else if (kind === 'csv') {
		doc = readCsvDocument({ name, attachment: ordinal, text: new TextDecoder().decode(bytes) });
	} else {
		doc = readTextDocument({ kind, name, attachment: ordinal, text: new TextDecoder().decode(bytes) });
	}

	return {
		doc,
		stored: {
			ordinal,
			fileName: name,
			kind,
			mediaType: MEDIA_TYPES[kind],
			bytes,
			sha256: sha256Of(bytes),
			byteSize: bytes.byteLength,
			pageCount: doc.pageCount,
			sheetCount: doc.sheetCount,
			rowCount: doc.rowCount,
			summary: doc.summary
		}
	};
}

export interface ReadRequest {
	/** What was typed or pasted into the box, if anything. */
	paste?: string | null;
	/** What was uploaded, in the order the form sent it. */
	files: File[];
}

export interface ReadResult {
	/** The paste box first (attachment 0), then the files that could be read. */
	documents: ParsedDocument[];
	/** The files to store with the draft. */
	stored: StoredFile[];
	/** Things worth saying that did not stop the read ("the same file twice"). */
	notes: string[];
	/** Files that were refused, each with its reason. */
	problems: string[];
}

/**
 * Read a whole request: the paste box and its attachments.
 *
 * A file that cannot be read does not stop the others: its reason goes into
 * `problems` and the page shows it. Four files is the most a draft holds, and
 * the same file twice is read once.
 */
export async function readRequest(input: ReadRequest): Promise<ReadResult> {
	const documents: ParsedDocument[] = [];
	const stored: StoredFile[] = [];
	const notes: string[] = [];
	const problems: string[] = [];

	const paste = (input.paste ?? '').trim();
	if (paste !== '') {
		try {
			documents.push(readTextDocument({ kind: 'paste', name: 'pasted email', attachment: 0, text: paste }));
		} catch (error) {
			problems.push(error instanceof DocumentError ? error.message : 'The pasted text could not be read.');
		}
	}

	const seen = new Map<string, string>();
	let ordinal = 0;
	for (const file of input.files) {
		if (!(file instanceof File) || file.size === 0) continue;
		if (ordinal >= MAX_FILES) {
			problems.push(
				`${file.name || 'a file'} was not read: a draft holds ${MAX_FILES} files at most. Make a second draft for the rest.`
			);
			continue;
		}
		const next = ordinal + 1;
		try {
			const { doc, stored: one } = await readUploadedFile(file, next);
			const already = seen.get(one.sha256);
			if (already) {
				notes.push(`${one.fileName} holds the same file as ${already}, so it was read once.`);
				continue;
			}
			seen.set(one.sha256, one.fileName);
			documents.push(doc);
			stored.push(one);
			ordinal = next;
		} catch (error) {
			problems.push(error instanceof DocumentError ? error.message : `${file.name || 'a file'} could not be read.`);
		}
	}

	return { documents, stored, notes, problems };
}
