// A small CSV reader for ERP exports, written here instead of pulled in as a
// package so every rule is visible.
//
// What real exports throw at it:
//   - a UTF-8 byte order mark before the first header
//   - quoted fields that contain commas, line breaks or doubled quotes ("")
//   - Windows line endings (CRLF), or plain LF, or a mix
//   - blank lines, especially at the end
//
// It returns records (arrays of cells). A quoted field can span lines, so a
// record is not the same thing as a line of text.

/** Split CSV text into records. Blank records (every cell empty) are dropped. */
export function parseCsv(text: string): string[][] {
	// The byte order mark is invisible in a spreadsheet but would otherwise
	// stick to the first header name.
	const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

	const records: string[][] = [];
	let record: string[] = [];
	let field = '';
	let inQuotes = false;
	let i = 0;

	const endField = () => {
		record.push(field);
		field = '';
	};
	const endRecord = () => {
		endField();
		if (record.some((cell) => cell.trim() !== '')) records.push(record);
		record = [];
	};

	while (i < input.length) {
		const ch = input[i];

		if (inQuotes) {
			if (ch === '"') {
				// "" inside quotes is one literal quote; a lone " ends the quoted part.
				if (input[i + 1] === '"') {
					field += '"';
					i += 2;
					continue;
				}
				inQuotes = false;
				i += 1;
				continue;
			}
			field += ch;
			i += 1;
			continue;
		}

		if (ch === '"') {
			inQuotes = true;
		} else if (ch === ',') {
			endField();
		} else if (ch === '\r') {
			// CRLF counts as one line break; a lone CR (old Mac files) does too.
			endRecord();
			if (input[i + 1] === '\n') i += 1;
		} else if (ch === '\n') {
			endRecord();
		} else {
			field += ch;
		}
		i += 1;
	}

	// The last record may have no line break after it.
	if (field !== '' || record.length > 0) endRecord();
	return records;
}

/** Quote a value for CSV output when it needs it. */
export function csvCell(value: string | number | null | undefined): string {
	const text = value === null || value === undefined ? '' : String(value);
	return /[",\r\n]/.test(text) || /^\s|\s$/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Records to CSV text with the given line ending. */
export function toCsv(rows: (string | number | null)[][], eol = '\r\n'): string {
	return rows.map((row) => row.map(csvCell).join(',')).join(eol) + eol;
}
