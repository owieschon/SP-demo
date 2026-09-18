# Five-minute walkthrough script

The order below tells one story: a customer's email becomes a commitment, the
morning's ERP file says what will ship late, a rule chases what people forget,
and the assistant does the looking up without being allowed to change
anything on its own.

Open https://sp-demo-one.vercel.app and sign in as Elena Brooks (Sales
Director, so everything is visible). Say once, at the start: "All the data is
invented; the numbers are shaped like a real parts business of this size."

## 0. Where this comes from (20 seconds)

"Northline makes heavy-duty truck exhaust parts. Its ERP can only export
files, its sales team lives in email, and nobody trusts the pipeline numbers.
Four things fix that, and each one is enforced in the database, not in the
page."

## 1. Commitments that measure themselves (60 seconds)

- Open **Commitments**. "A commitment is a named buyer's promise: these parts,
  this window, this value. The status is never typed in."
- Point at a delivering card: "$12,003 of $17,210 came from the invoice
  ledger, matched on part numbers, because parts arrive mixed into whatever
  order the customer happens to place."
- Open a commitment. Show the matched lines and one line that came in through
  a branch: "branches bill to the head office, so the head office's
  commitment counts them."
- Show the banner, "N windows closed short", open the answer flow, answer one.
  "The only thing a person types is what happened, and their name is on it."
- One sentence on speed: "That board was 11 seconds on the full world. It is
  now 6 to 10 milliseconds, and `docs/sql.md` shows both query plans."

## 2. Quote requests at the order desk (70 seconds)

- Open **Order desk**, pick an item that arrived, and open it.
- "Nobody uploaded this. It arrived in the desk's mailbox and the agent read
  it." Expand **What the agent did, step by step**: the lookups with their
  arguments, and the refusals with the rule that stopped each one.
- "The model proposes. Then code checks every field against the catalog and
  the customer master." Point at one `corrected` field and one
  `needs review` with its reason, and at a sibling suggestion for a part
  number that does not exist.
- "The draft is stored server-side. Approving sends only its id and version,
  so what gets created is the checked draft, not whatever the browser sends."
- Approve: a quote and a commitment in `quoted` appear, and the commitment
  opens.
- "Twenty-eight invented emails score the extractor field by field, and a test
  fails if the score drops."

## 3. The morning ERP file, and what will ship late (80 seconds)

- Open **Operations**. Download "Yesterday's export", upload it, apply it.
  Then upload "Today's export": show new, shipped and newly short.
- Upload **Wrong report**: refused, with the missing columns named. Upload
  **Partial export**: held, with the reason. "Nothing reaches the live table
  until a person applies it, and a file is recognized by its contents, not its
  name, because the ERP stamps the time into every filename."
- Open the **forecast**: "Stock and incoming purchase and production orders are
  handed out over time, so every open line has a projected ship date and a
  reason: waiting on a purchase order due Oct 3, or nothing on order at all."
- Show the vendor call sheet: "dollars held up per vendor, which is the call a
  buyer makes next."

## 4. Automation a non-engineer can set up (60 seconds)

- Open **Automations**, open "Call key accounts that went quiet".
- Read the sentence aloud: "When an account has gone quiet, if quiet as a
  multiple of its usual gap is at least 2 and revenue in the last 12 months is
  at least $25,000, add a next step for the record owner."
- Press **Test this rule**: "It would match N accounts right now, and here
  they are. The test runs in a transaction Postgres itself marks read only, so
  a test can never write."
- Change a number, test again, save. "A rule is data, not SQL. The conditions
  compile to bound parameters over one of a fixed set of reviewed queries, so
  a rule can never ask for something the catalog does not allow, and it fires
  at most once per record."

## 5. Ask Northline, and the gate (50 seconds)

- Open **Ask**. Ask: "Which windows closed short last month and what is
  missing?" Show the lookups it made.
- Ask it to change something ("mark C-5639 as pushed"). It comes back as a
  proposal card: "Nothing runs until you approve."
- "Every tool has a risk class. Reading and adding run; anything that changes
  or removes data cannot be run by the model at all. It can only propose, and
  approval executes the same database function the button uses, under my name,
  with an audit row."
- Mention the mode badge: "This is the scripted demo model, so a visitor
  cannot spend my API budget. Live mode needs a key and a passphrase."

## 6. Close (20 seconds)

"Four workflows, one database that enforces the rules: every write goes
through a function that checks the person, the field rules and the row
version, and writes an audit row. 200-odd tests run against real Postgres
compiled to WebAssembly, so `npm test` needs nothing installed. The repo's
README links the SQL write-up, the decisions and this script."

## Practical notes

- Record at a window width where the left rail shows labels (about 1,100
  pixels or more).
- Have the sample files already downloaded, so the demo does not wait on a
  download.
- If the nightly rebuild has just run, Operations starts empty; that is the
  intended starting point for beat 3.
- Do not sign in as Terry Vance (inactive on purpose) unless showing that
  refusal.
