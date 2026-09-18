# Documents in, documents out

A request for quote does not arrive as a tidy paragraph. It arrives as a
spreadsheet with a merged header, a printed purchase order saved as a PDF, a
CSV pulled out of somebody's system, or a covering email with all three
attached. And a quote does not finish on a screen: it has to leave the
building as a file somebody can read and an email somebody can send.

This is how both halves work.

## Documents in

### What is accepted

| Extension | Read as | Tables |
|---|---|---|
| `.txt` | plain text | no, the extractor reads it |
| `.eml` | plain text, headers kept | no, the extractor reads it |
| `.pdf` | text with its layout kept | yes, one per page |
| `.xlsx`, `.xls` | every sheet | yes, one per sheet |
| `.csv` | the ERP reader's CSV splitter | yes |

Plus whatever is pasted into the box on the page, which is read as plain text
and counts as attachment 0.

Four files a draft, ten megabytes a file. Both caps are checked twice: in the
reader, so the page can say which file and why, and in
`nl.add_rfq_attachment`, so no other caller can get round them.

`.msg` is refused, with the fix in the message: in Outlook, File then Save As,
then Text Only. An Outlook `.msg` is a compound binary container, and reading
it properly is a project of its own for a format one mail client uses.

### Why a file is what its bytes say, not what it is called

`kindOfFile` in `read.ts` reads the first bytes of every upload and refuses a
name and a signature that disagree. A PDF named `order.txt` is refused rather
than read as text. A Windows program is refused outright. Nothing executable
is stored, and nothing is ever served as HTML.

That check is also what fixes the media type. The type a browser claims for an
upload is a claim, not a fact, so it is thrown away: the kind decided from the
bytes picks the media type out of `MEDIA_TYPES`, migration 0020 holds the same
pairs in a check constraint, and that stored type is what a download is served
as, with `content-disposition: attachment` and `x-content-type-options:
nosniff`.

### Tables win over prose

Where a document has columns, the columns are the lines. A spreadsheet, a CSV
and most printed purchase orders say exactly what they mean in a table, and
reading a table is exact. Prose is where an extractor has to guess, so prose
is where the extractor (the rules reader, or Claude in live mode) is used.

Per document:

- tables found: the lines come from the table's rows, and no extractor runs at
  all,
- no tables: the lines come from the extractor reading that document's text.

A table's columns are matched by name, with case and punctuation thrown away,
so `Item #`, `ITEM NO.` and `item number` are one thing (`tables.ts` holds the
list). A row of labels only counts as a header when it names a part column and
at least one of quantity, price or amount, so a stray line reading
`Notes | Thanks` is not a table. A row with a part number but no quantity, no
price and no date is a note somebody typed under the table, not a line.

Plain text and `.eml` are deliberately left to the extractor even when they
hold a pipe table, because the rules reader already handles tables written in
text and handles them better: it also understands the words around them
("2 dozen", "a box of 10", "@ $201.75").

### One document, one reading

Each document is read on its own, not as one long block of text. An email is
not a spreadsheet: the email reader looks for headers at the top and a sign-off
at the bottom (`rfq/email.ts`), so gluing a covering note to a parts list would
put the parts list under the sign-off, where a signature is not read as a
request.

The facts that are not lines (who sent it, which company, the needed-by date,
the shipping notes) come from the first document, which is the covering email.
Anything it does not say, a later document may fill in. A table's own stated
total and its needed-by dates fill in what the prose never mentioned.

One consequence worth knowing: a request with two prose attachments makes two
extractor calls, and in live mode that is two model calls. A request whose
attachments are tables makes none for them. The cheapest thing a customer can
send is also the most exact.

### Where every line came from

Every extracted line carries a source reference, and the review page shows it
next to the line:

```
attachment 2, sheet Quote, row 14
attachment 1, page 1, line 8
pasted email, line 3
```

Spreadsheet rows and CSV rows are numbered the way the file numbers them, so
row 5 is row 5 when somebody opens it. PDF lines are numbered within their
page.

The reference lives on the draft (`draft.lines[].source`), not on the
validation. It is also deliberately outside the zod schema: that schema is
what builds the JSON schema a live model must answer in, and a model cannot
know which sheet and row a line sat in. Keeping it in the TypeScript type and
out of the schema leaves the model's contract alone.

### Numbers, and the one that is a date

A spreadsheet cell holding `46312` is either the price of something or
2026-10-17, and the only thing that says which is the cell's number format.
So the reader looks at the format (`isDateFormat`) and converts the serial
with date-only arithmetic in no time zone at all (`dateFromSerial`, counting
days from 1899-12-30, which is the epoch Excel's leap-year bug leaves it
with). A CSV and a PDF have no formats, so their cells are read
conservatively: something is a number only when the whole cell is one, and a
date only when the whole cell is one.

Merged headers are flattened before anything else: a merged range's value only
sits in its top-left cell and is blank everywhere else, so every cell the
range covers takes that value. A header split over two rows then reads
correctly too, because a blank header cell borrows the label above it.

### A PDF has no lines

PDF.js reports every piece of text on a page with the position it was drawn
at, and nothing about lines. So lines are rebuilt: pieces drawn at about the
same height are one line, ordered left to right, and the gap between two
pieces becomes spaces. A gap wide enough to be a column becomes two or more
spaces, which is what the table finder reads as a column break.

That last part is the whole trick, and it has a catch worth writing down:
PDF.js reports a gap as a piece of text of its own holding a single space,
whose width is the width of the gap. Those are dropped and the gap is measured
from the positions instead. Keeping them would turn every column break into
one space, and every table into word soup. (It did, the first time.)

A PDF with no text at all is a scan. There is nothing in it to read, so it is
refused with a message that says so, rather than quietly producing an empty
draft.

### Storing them

`nl.rfq_attachments` (migration 0020) holds the bytes in a `bytea` column with
the file name, the media type, the size, a SHA-256, and what was read out of
it (pages, sheets, rows, and the one-line summary the panel shows).

- The hash always describes the stored bytes: the SQL function computes it
  itself and refuses one that disagrees.
- The same bytes are stored once per draft (`unique (draft_id, sha256)`), and
  a repeat returns `duplicate: true` rather than writing. A file that was
  already read into an earlier draft of yours is recognized before anything is
  written, and the page names that draft instead of making a second one.
- A draft and its attachments are written in one transaction, so neither can
  exist without the other.
- Row-level security: an attachment is part of a customer's email, so it is as
  private as its draft, which means its creator or an admin. `nl_readonly`,
  the assistant's SQL role, has no grant on it at all. Somebody else asking
  for an attachment gets nothing back, and the route answers 404: exactly what
  a file that does not exist gets.
- `nl.rfq_attachment_index` is the same rows without the bytes. Every list and
  panel reads that, so counting a file's pages never pulls ten megabytes
  through the connection.

## Documents out

### One object, three renderings

`QuoteDoc` (`quote.ts`) is the whole quote: the customer, the buyer, the
lines, the subtotal, the freight note, the terms. The web page, the PDF and
the email body all render that one object, so they cannot show different
numbers. The test proves it by reading the PDF back and comparing.

There are two kinds:

- an approved quote, read through `nl.quote_document`, the view that derives
  the subtotal from the lines in SQL,
- a draft quote, built from the draft's stored validation, which is exactly
  what the review page shows.

Money is worked in whole cents here, the same way `rfq/validate.ts` and
`nl.approve_rfq_draft` work it, so the review page, the quote and the PDF
cannot differ by a rounding cent. The test asserts `loadQuoteDoc`'s subtotal
against the view's, because two figures worked out separately are worth more
than one worked out once.

### The PDF

Drawn with `pdf-lib`: no browser, no native module, no font files. The four
standard fonts are named in the document rather than embedded, so a three-line
quote comes to a few kilobytes and the whole thing runs in a plain Node
function.

It carries the letterhead, the quote number, the date and the valid-until
date, the customer and the buyer, the lines (part number, description,
quantity, unit price, extended), the subtotal, the freight note, the terms,
and a footer saying it is a portfolio demo on invented data. A draft quote
says DRAFT QUOTE across the top and carries a line saying nothing has been
approved: a draft going out unmarked is how a price nobody agreed to becomes a
price somebody expects.

Long quotes run onto more pages, redrawing the table header, and every page is
numbered. Text is cut to fit its column rather than allowed to spill, and
characters the standard fonts cannot write are folded to ones they can
(curly quotes, dashes) or dropped.

| Route | What it serves |
|---|---|
| `GET /quotes/<id>/pdf` | an approved quote |
| `GET /rfq/<id>/quote` | the quote a draft would become, before approval |
| `GET /rfq/<id>/attachments/<attachment>` | one of the files that arrived |

### "Open in your mail app"

The button opens a `mailto:` link with the buyer's address, a subject ("Quote
448123 for 6 parts, valid to Oct 17") and a body summarizing the lines and the
totals.

A `mailto:` link cannot carry a file. No browser lets a link attach anything.
So the page says that, in those words, and puts the download first, because
the order of the buttons is the order of the work: get the PDF, open the
email, attach the PDF, send. Pretending otherwise would be worse than saying
it.

Everything in the link is percent-encoded. A customer called "Hobbs & Vance
Truck Parts" would otherwise end the body and start a header of its own.

## The packages, and one thing to know about one of them

| Package | Version | Why |
|---|---|---|
| `pdf-lib` | 1.17.1 | writes the quote PDF, no browser, no native module |
| `unpdf` | 1.8.1 | PDF.js built for serverless, for reading text out of a PDF |
| `xlsx` | 0.20.3 | SheetJS, for `.xlsx` and `.xls`; installed from the official SheetJS CDN |

`unpdf` rather than `pdfjs-dist` directly: it ships the same PDF.js compiled
for serverless functions, with no optional native canvas dependency to install
or skip. `extractTextItems` gives the positions the layout rebuilding needs.

The public npm registry stops at vulnerable `xlsx` 0.18.5. SheetJS publishes
fixed Community Edition releases on its own CDN and documents that CDN as the
authoritative source in its [official Node installation
guide](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/).
This app pins the exact 0.20.3 tarball URL in `package.json`;
`package-lock.json` pins its SHA-512 integrity. Version 0.20.3 includes the
fixes released in 0.19.3 for
[CVE-2023-30533](https://cdn.sheetjs.com/advisories/CVE-2023-30533) and in
0.20.2 for [CVE-2024-22363](https://cdn.sheetjs.com/advisories/CVE-2024-22363).

That upgrade addresses those two known advisories. It does not make an
arbitrary workbook safe. The ten-megabyte upload limit is checked before
`XLSX.read`. Once a file passes that check, SheetJS decodes the workbook
before this app applies its post-parse extraction limits of 20 sheets, 5,000
rows and 80 columns per sheet. Those limits bound the retained grid, not all
parser work or resource-exhaustion behavior.

## Tests

- `app/src/lib/server/documents/documents.test.ts`: every reader on every
  fixture, column matching, the caps, the refusals, the download headers, the
  PDF read back with `unpdf`, the mailto escaping. No database.
- `app/src/lib/server/documents/attachments.test.ts`: storing attachments, who
  may read them, a spreadsheet request read end to end, the same request
  pasted as text giving the same lines, and a CSV request approved into a
  quote whose page, PDF and email agree.

## The fixtures

`fixtures/rfq/`, rebuilt by `node scripts/rfq-fixtures.ts` from `app/`:

| File | What it is for |
|---|---|
| `emailed-spreadsheet-request.xlsx` | three sheets, a header merged over two rows, real date cells, a stated total |
| `legacy-spreadsheet-request.xls` | synthetic BIFF8 cells written by the prior SheetJS 0.18.5 install, for an independent legacy-reader regression |
| `emailed-spreadsheet-request.txt` | the same request as text, so a test can prove both read the same |
| `pdf-request.pdf` | a two-page printed purchase order, text based |
| `parts-list.csv` | a parts list with a preamble and a trailing note |
| `scanned-request.pdf` | one page holding an image and no text, which must be refused |

Every customer, contact and part in them exists in the eval world
(`evals/rfq/world.json`), and the prices are worked out from that world's list
prices and the customer's price group, so the figures in the files are the
figures the app would quote. The files are committed, so the tests never run
the script: a failure in a test is a change in the readers, not a change in
the files.
