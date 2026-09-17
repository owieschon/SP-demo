# Northline: interface and agent audit

Written 2026-09-17 on branch `ux-audit`, against `main` at `16fbd58`.

Read this in three passes. First the standard, so the findings can be argued
with. Then every screen a person sees. Then the same app used by an agent.
The ranked twenty at the end is what to do about it.

Measured, not guessed: a headless Chromium signed in and walked 22
addressable views at 1440 and 375 pixels, in light and dark, recording
rendered font sizes, contrast ratios against the real composited
background, tab order and focus visibility, tap target sizes, field font
sizes, landmarks, headings, table headers, page titles, horizontal
overflow and console output, plus a screenshot of each. The script is not
committed; the numbers it produced are quoted inline and marked
"measured". Anything marked "inferred" came from reading the source only.

Two views could not be measured: `/rfq/<id>` and `/ask/<id>`. The `small`
seed world has no drafts and no conversations, so there is nothing to
link to. They were audited from the source instead.

Three findings came out of the browser and out of nothing else, and two of
them are the most visible things wrong with this app. They are numbers 1
to 3 in the ranked list: the desktop rail scrolls its own icons out of
view on every navigation, eleven of twenty-one pages scroll sideways on a
phone, and the first Tab press lands in the middle of the rail on
eighteen of twenty-two pages.

---

## The standard

How a good web application is designed in 2026. Fourteen rules, each one
checkable. Northline's score against each is in the last column: **met**,
**partly**, or **broken**.

| # | The rule | Northline |
|---|---|---|
| 1 | **A shared component layer is the product.** Page, DataTable, Dialog, Tabs, Stat, Field, Menu, Tooltip, EmptyState built once and used everywhere. Per-screen construction is what makes an app feel unsteady even when no single screen is ugly. | **broken** |
| 2 | **One type scale**, five or six sizes, nothing under 12px, no half steps. | **broken** |
| 3 | **Three radii plus round**, and an inner radius never larger than its outer. | **met** |
| 4 | **Two content widths only**: a list width and a reading width. | **broken** |
| 5 | **Money and counts in the brand sans with tabular figures.** Monospace is for identifiers only. Mono on every dollar figure makes a sales screen look like a developer tool. | **met** |
| 6 | **Hover, active and selected are three visually distinct states**, and every interactive element has rest, hover, focus-visible, active, disabled and loading. | **partly** |
| 7 | **Two-layer shadows for overlays**, tight plus soft. One big blur looks pasted on. | **met** |
| 8 | **Say less and point at the next action.** An empty state is one line and one button, not a paragraph. | **partly** |
| 9 | **Zero is not news.** Fold or hide empty counts rather than giving them full weight. | **partly** |
| 10 | **Never a bare figure without provenance.** A derived number carries its source and an as-of date, as a component rather than ad hoc labels. | **broken** |
| 11 | **Deep-link everything.** Filters, sort, tab, grouping and view mode live in the URL. | **partly** |
| 12 | **Links are links.** Anything that navigates is an anchor, so middle-click and copy-link work. | **met** |
| 13 | **Use the platform**: native dialog, popover, anchor positioning, view transitions, container queries. | **partly** |
| 14 | **Accessibility as craft, not a checklist**: skeletons that match the shape of what arrives, errors that say what happened and what to try, keyboard reachability for every action, motion that respects `prefers-reduced-motion`, dark mode designed rather than inverted, phone layouts that are not a squeezed desktop, and copy written like a person wrote it. | **partly** |

Four things this app already does better than the app this standard was
measured against, and they should not be traded away:

- **Money is never monospace.** `.mono` is applied to item numbers,
  invoice numbers, document numbers and record ids, and dollar figures get
  `.num` (tabular numerals, right aligned, brand sans). Rule 5, met
  throughout, checked in every one of the 72 components.
- **Dark mode is designed, not inverted.** Every colour resolves through
  `light-dark()` in `app/src/app.css`. Measured: switching the emulated
  colour scheme produced no missing surface and no unreadable status
  colour on any of the 23 views. The only hardcoded colours were four
  shadow alphas over neutral.
- **Every page has one `<main>`, one `<h1>` and a title that names the
  record.** Measured on all 21 pages: `main=1 h1=1` everywhere, and
  per-record titles like `C-3014 ... · Northline`, `{a.name} · Northline`,
  `{p.itemNo} · Northline`. The comparison app had one tab title for the
  whole product.
- **No native `confirm()` or `alert()`, anywhere.** Grepped and confirmed
  zero. Nothing in this app can stall an agent on a dialog it cannot see.

Two more that are close: `prefers-reduced-motion` is handled globally
including the press transforms, and filters are GET forms so list views are
already links.

---

## Pass 1: every screen a person sees

### The shared layer, judged first because everything inherits it

`app/src/app.css` is a real design system: `.panel`, `.panel-head`,
`.button` with four variants, `.chip`, `.notice`, `.segmented`,
`.skeleton`, `.num`, `.mono`, table and field defaults, and a global
`:focus-visible`. The features use it. The failure is entirely above that
line: what a panel contains was re-invented in every file.

Counted across the 72 components and 21 pages:

| Pattern | Copies | Variants |
|---|---|---|
| Stat tile | 13 | 13 designs, `flex-basis` 120 / 130 / 140 / 150 / 160 / 170 / 190 px, figure size 1.05 / 1.1 / 1.2 / 1.25 / 1.3 / 1.35 rem, four of them under the same class name `.figures` |
| Page shell (`max-width` + `margin` + `padding` + `grid`) | 14 | 8 widths: 480, 520, 720, 860, 880, 900, 980, 1080, 1180 px |
| `.small` | 16 | 4 sizes: 0.85, 0.88, 0.9, 0.92 rem, one class name |
| `.table-wrap { overflow-x: auto }` | 13 | 5 `max-height` values: none, 360, 380, 420, 460 px |
| Sticky `thead th` | 5 present, **3 missing on scrolling tables** | |
| `.body { padding: var(--space-3) }` | 10 | |
| List reset + `li + li { border-top }` | 11 | |
| `.spinner` + `@keyframes spin` | 4 | 3 different constructions |
| Segmented / tab strip | 3 | `app.css` `.segmented`, `operations` `.tabs`, `RuleEditor`'s label-based re-skin that duplicates the `[aria-pressed]` rule verbatim |
| Form-result notice and its "did it fail" rule | 7 | 7 different predicates |
| `use:enhance` saving-flag boilerplate | 16 | |
| Small button (`height: 22px`) | 4 | 3 class names: `.small`, `.button.small`, `.tiny`, `.token` |
| Field label | 3 patterns | bare text, `<span>`, `.sr-only` |
| "No value" glyph | 3 | `·`, `not stated`, empty string, in 14 places |
| `@media (max-width: 720px)` | 28 files | the only breakpoint in the app |

**Severity: high.** This is the finding behind the owner's verdict. No
screen is ugly; the app is unsteady because a panel on `/operations` and a
panel on `/warehouse` are two different panels that happen to look similar.
Fixing it fixes the inconsistency, several behaviour bugs and the agent
readability at once, which is why it is number one in the ranked list.

**Measured type scale.** 20 distinct sizes are declared in the source.
Rendering the 22 views at 1440 in light mode put **15 of them on screen**,
and **8 are under 12px**:

| Rendered | Text nodes | What it is |
|---|---|---|
| 9.75px | 11 | `.eyebrow`, `RuleEditor .step-no` |
| 10.14px | 47 | `SearchBox kbd`, `SalesChart` ticks and peak |
| 10.4px | 28 | `signin .avatar` |
| 10.66px | 688 | `.chip`, `.portfolio-note`, `Conversation .when`, `RevenueBars` labels |
| 11.05px | 1326 | `th`, and 28 local declarations |
| 11.44px | 601 | 10 local declarations |
| 11.7px | 55 | 9 local declarations |
| 11.96px | 1371 | `h3`, `label`, `.panel-head h2`, `.segmented`, 13 local declarations |
| 13px | 5206 | the body |
| 13.65 to 17.55px | 66 | six sizes, for every heading and every figure in the app |

So **4,127 text nodes render under 12px, against 5,206 at body size**, and
the whole heading and figure range is 66 nodes across six sizes. The
hierarchy is inverted: the app has a lot of very small text and almost no
large text. Plus a compounding bug: `.mono` set `font-size: 0.92em`, so a
part number inside a 0.85rem cell rendered at **10.2px monospace**. The
comparison app's worst finding was 18 declared sizes including a 9.5px;
this one had 20 including a 9.75px.

**Measured contrast. 89 distinct failures in light, 86 in dark**, the
worst at **2.66:1** against a 4.5:1 requirement. Two causes:

- `--text-faint` was **3.00:1 on white** and **3.32:1 in dark**, and it
  carried real content, not decoration: `.explain`, `.more`,
  `.column-total`, `.raw`, `.id`, every card percentage, `.state` on the
  automations list, every chart magnitude label. It appeared on 19 of the
  22 views.
- `.faint` stacked with a second dimming, for example
  `SearchBox kbd` (**2.66:1**, on all 21 signed-in views),
  `span.faint.desc` in `RecentMoves` (2.66:1, the item description a
  picker reads), `td.mono.nowrap` in the warehouse ledger (2.66:1, a sales
  order number), and `p.faint.small` on `/rfq` (2.66:1, the sentence
  explaining why live mode is off).

**Severity: high**, both. Fixed at the token level in `app.css`, see "What
I changed"; the stacked cases need the `.faint` usages in route files
changed to `.muted`, which is instruction 17 below.

### `/signin`

For: picking who to be. There are no passwords, on purpose.

This is the best-built screen in the app and the model the rest should
copy. Its submit is the only one with `disabled` **and** `aria-busy`
**and** a per-item pending id **and** a visible spinner.

- **medium** `signin/+page.svelte:67` The reason an inactive person's
  button is dead sits in a 0.92rem line below it and reads as a note about
  the demo, not as why the control cannot be pressed. Fix: put "no longer
  active" next to the button.
- **medium** `:55-86` The button's accessible name is the full name plus
  the title plus the whole role sentence, about 90 characters. Fix:
  `aria-label="Sign in as {user.fullName}"`.
- **low** `:39-42, :75` "Every database call runs as the person you pick,
  and the database decides what they may change" is developer copy on the
  front door. Defensible for a portfolio piece, and it is the most
  machine-sounding sentence in the app. Fix: keep one sentence, move the
  mechanism to a "how this works" link.
- **low** `:213-232` A bespoke spinner and its own `prefers-reduced-motion`
  block, the only ones outside `app.css`. Fix: use the shared `.spinner`.

### `/commitments`

For: a rep's whole book in six lanes. The one page with a real streamed
load, a plain-sentence catch and a working retry.

- **high** `Board.svelte:99-108` The three open lanes are uncapped; only
  the settled lanes have a limit. A rep with 200 promised commitments
  renders 200 cards. Fix: cap all six and reuse the existing "and N more"
  at `Board.svelte:106`.
- **high** `CommitmentCard.svelte:62-69` Every row action is named
  "Answer" or "Open C-4812". A board of 40 cards presents 40 identically
  named actions. Fix: `aria-label="Answer: {card.title}"`.
- **high** `CommitmentCard.svelte:66` The revealed row action carries
  `tabindex="-1"`, so the only visible action on the card is unreachable
  by keyboard while being revealed by `:focus-within`. Fix: drop the
  `tabindex`, or drop the hover-revealed action, since the whole row is
  already a link.
- **high** `CommitmentCard.svelte:54` "Name the buyer" is a call to action
  rendered as an 18px static chip with no hover, active or focus styling.
  Fix: partly done, `a.chip` now has control states and height in
  `app.css`; the chip still needs to go to a working target, see the next
  finding.
- **high** `CommitmentCard.svelte:54` plus `BuyerPicker.svelte:48` The
  chip links to `/commitments/{id}#buyer`, which scrolls to the div and
  leaves the picker closed. The promised action delivers a scroll. Fix:
  read the hash in `BuyerPicker` and open the picker.
- **medium** `Board.svelte:53-71` The four headline totals carry no
  comparison: no target, no prior period, no share. Fix: "Delivered
  $840K, 68% of committed".
- **medium** `Board.svelte:68` Expected's only source label is a `title`
  attribute, invisible on touch and to a keyboard. Same at
  `CommitmentCard.svelte:40` and `ProgressBar.svelte:38`. Fix: a visible
  caption under the strip.
- **medium** `Board.svelte:192-200` `grid-template-columns: repeat(6,
  minmax(232px, 1fr))` inside an `overflow-x: auto` scroller with
  `scroll-snap-type`. This is the CSS Grid combination the project's own
  rules flag for Safari iOS, and the sibling `.two` at
  `rfq/[id]:348` already shows the flex answer. Fix: flex row with
  `flex: 0 0 232px`.
- **medium** `commitments/+page.svelte:15-19` `<h1 class="sr-only">`, and
  the layout hides the breadcrumb on phones because "the page's own
  heading already names the section". On a phone this board has no visible
  title. Fix: make the h1 visible.
- **medium** `commitments/+page.svelte:16-19` The only header copy
  explains the data model, not the task. Fix: one line saying what a rep
  does here.
- **medium** `ProgressBar.svelte:38-41` The 95% kept line and the pace
  tick are two grey 1-2px marks, told apart only by `title`, with no
  legend. The pace tick is the whole point of the bar. Fix: a one-line
  legend under the lane head.
- **low** `BoardSkeleton.svelte` Four measured mismatches against what
  arrives: 84px rows against ~110px cards, 4 bars against 5 to 6 lines,
  `overflow-x: hidden` against `auto` so a scrollbar appears on swap, and
  no reserve for the "closed short" banner. Fix: `SkeletonRows` with the
  real row height, or mirror the card's lines.
- **low** `Board.svelte:92-98` "$820K exp. of $1.1M" abbreviates
  "expected" in the one place the figure must be unambiguous.
- **positive** `Board.svelte:93` "Last 90 days · $340K" is the one figure
  in the app that states its own window.
- **positive** `ProgressBar.svelte:25-34` A correct `role="progressbar"`
  with label, min, max, now and valuetext, and length carries the value
  independently of colour. Nothing else in the app uses it.

### `/commitments/<id>`

For: one commitment, its scope, what has landed against it and the two
fields a rep sets.

- **high** `+page.server.ts:10-19` Nothing streams. Five sequential
  queries plus `listBuyerChoices` resolve before the shell renders, so one
  slow query blocks the header too. Fix: await `head` only; stream items,
  lines, outcomes and quotes.
- **high** `+page.svelte:214-242` The matched invoice lines table renders
  every line, and the query has no `LIMIT`. A long cadence commitment
  renders hundreds of rows with no "showing N of M". Fix: cap at 50,
  newest first, and a `RowCount`.
- **high** `+page.svelte:180-201, :214-242` Two tables with no `scope` on
  any `<th>`, and on a phone they stay as 5- and 7-column horizontal
  scrollers while `DraftLines` in another feature turns into labelled
  cards. Two mobile table strategies in one app. Fix: `scope="col"`, and
  pick one strategy.
- **medium** `+page.svelte:107-124` Four headline figures with no source
  and no as-of, and only Delivered carries a comparison.
- **medium** `+page.svelte:114` `percent()` rounds, so 94.6% delivered
  prints "95%" while the status is not `kept` and the bar sits left of the
  95% line. Fix: floor when comparing against a threshold.
- **medium** `+page.svelte:110` versus `:237` `money()` (whole dollars) in
  the figures and `moneyExact()` (cents) in the table, so the running
  total visibly disagrees with Delivered. Fix: one precision per screen.
- **medium** `+page.svelte:237` `moneyExact(-0.004)` prints `-$0.00`.
  Confirmed in a REPL: `money(-0.4)` returns `-$0` and `count(-0)` returns
  `-0`. Fix: clamp in `format.ts`.
- **medium** `+page.svelte:161-166` The confidence select has no
  `aria-describedby` to the sentence that explains what it does, and Save
  is enabled with the value unchanged, writing a no-op audit row.
- **medium** `+page.svelte:465-470` `repeat(auto-fit, minmax(260px, 1fr))`,
  the Safari iOS grid pattern again.
- **medium** `+page.svelte:291-302` Next steps empty state is the single
  word "None." on a screen that can add one.
- **medium** `+page.svelte:195` `{item.quantity ?? '·'}` A screen reader
  reads "middle dot". Same in 14 places.
- **low** `+page.svelte:137` "Expected = delivered + 34% confidence ×
  remaining" is a formula printed to a salesperson. Honest, and it belongs
  behind a disclosure.
- **positive** `+page.server.ts:22-27` Fresh per-load request ids for
  every form on the page.

### `/commitments/answer`

For: the one question the app asks a rep, when a window closes short.

- **high** `OutcomeForm.svelte:51` `await update()` defaults to
  `reset: true`, so a server refusal wipes the note the rep typed and the
  error tells them to try again with nothing to try. Fix:
  `update({ reset: false })`, or reset only on success.
- **high** `+page.server.ts:14-17` Nothing streams and there is no
  `catch`, so a failed query gives a 500 page where the board gives an
  inline notice.
- **medium** `+page.server.ts:14` It runs the whole six-lane board query
  and then filters in JavaScript to show one card.
- **medium** `OutcomeForm.svelte:66-73` Three submits, none primary, and
  "They didn't buy" (a permanent record) looks identical to "Close
  enough". Fix: `.button.danger` on the broken choice.
- **medium** `+page.svelte:66` `aria-busy` marks the leaving question, but
  the arrival of the next one is never announced. A screen reader user
  answers and hears nothing. Fix: `aria-live` on the block, or move focus
  to the new heading.
- **medium** `+page.svelte:111-121` "Up next" rows are 34px with hover and
  no `:active`.
- **medium** `+page.svelte:52-53` "Nothing is waiting for an answer." with
  no way back to the board.
- **low** `+page.svelte:129` `max-width: 720px` against 1080px on its own
  sibling detail page.
- **positive** `types.ts:37-41` "Still coming / Close enough / They didn't
  buy" with one-line hints is the best microcopy in the app.

### `/accounts`

For: the book, filtered and sorted. The best URL state on any list.

- **high** `+page.svelte:110` No `max-width` at all while every sibling
  caps at 900 to 1180. On a wide monitor the list stretches edge to edge
  and the four figure columns fall apart.
- **high** `AccountsTable.svelte:77-144` The list is `<ul><li>`, not a
  table, so there are **no column headers at all**: four aligned figure
  columns and a reader has to infer that the middle one is a date. The one
  place the app most needs `<th scope="col">` has no header row.
- **high** `AccountsTable.svelte:132-141` The only row action is an icon
  link with `tabindex="-1"` and `display: none` under `(hover: none)`:
  unreachable by keyboard, invisible on touch, and a duplicate of the row
  link. It does carry the record name, which is right.
- **high** `+page.server.ts:19` `listFilterOptions` is the only awaited
  call and it runs two serial `select distinct` queries, so one slow
  DISTINCT blocks the whole page while the rows people came for are
  already streaming.
- **high** `+page.svelte:87` The page's primary action is a plain
  `.button`, identical to the Clear link beside it, while `/search` uses
  `.button primary` for the same job.
- **medium** `+page.svelte:98` `SectionSkeleton rows={8}` at 34px stands
  in for up to 50 rows at ~51px: the page grows by roughly 2100px when
  the rows land, and the sort strip and pager appear from nothing.
- **medium** `AccountsTable.svelte:29-31` "Page 2" with no total page
  count.
- **medium** `AccountsTable.svelte:53-65` Sort is three segmented anchors
  with no direction toggle; `/parts` uses a select; `/vendors` cannot sort
  at all. Three designs for one affordance. Also `aria-current="true"`
  where `"page"` is the correct token for a link.
- **medium** `+page.svelte:159-162` 14px checkboxes.
- **low** `+page.svelte:40` The role-derived `who` default is written into
  the URL on the first search, so `?who=all` appears without the user
  choosing it.
- **low** `AccountsTable.svelte:105` "orders every 43d, quiet 12d" is
  abbreviated to code; the detail page writes it out.
- **low** `AccountsTable.svelte:69-75` "Clear the filters" is offered even
  when no filter is set.
- **positive** `+page.svelte:104` The only retry in the app that preserves
  the user's filters. `/parts` and `/vendors` throw them away.

### `/accounts/<customer_no>`

For: everything about one account, on one scroll.

- **high** `+page.svelte:286-318` A third `.figures` stat tile design, and
  a fourth in `AccountsTable.svelte:244`, all under the same class name.
- **high** `+page.svelte:152, 170, 178, 186, 204, 222` Six `{:catch}`
  blocks, each a bare sentence with no retry. Six sections can go dead
  with a full reload as the only recovery. Fix: `LoadFailed`.
- **high** `AccountOrders.svelte:11-21` `openTotal` sums the rows the page
  has, which SQL capped at 50, and the header presents it as "N open lines
  worth $X". For an account with more than 50 open lines **the headline
  dollar figure is wrong** and nothing says so. This is the one
  number-correctness bug in the app. Fix: sum in SQL over all lines,
  return the count separately.
- **high** `AccountOrders.svelte:28-37, :67-76` Fourteen `<th>` across two
  tables, none with `scope`, no sticky header, up to 50 rows.
- **high** `ContactList.svelte:191-194` "No longer there" is a checkbox
  visually identical to "Primary contact" two lines above, committed by the
  same Save, with no confirmation and no undo.
- **high** `ContactList.svelte:73-99` No `autocomplete` on Name, Title,
  Email, Direct phone or Mobile, so a browser will offer the rep's own
  saved details when adding a customer's contact. `VendorContacts` sets
  `autocomplete="off"` on the same four. Fix: match it.
- **high** `AccountDeals.svelte:22-26` The only empty state in the app with
  no next action at all: two sentences of data-model explanation and
  nowhere to go.
- **high** `RevenueBars.svelte:38` The zero line is computed from the
  **first bar alone** (`bars[0].y + bars[0].height`). When the first month
  is negative the axis is drawn at the bottom of that bar and every other
  bar is read against the wrong zero.
- **high** `RevenueBars.svelte:21-30, :82` Room below the baseline is a
  fixed 12px but a negative bar scales against up to 50px, and the svg is
  `overflow: visible`, so a large credit month draws over the caption.
- **high** `RevenueBars.svelte:86-93` The last 12 months and the 12 before
  them are distinguished **only by fill colour**, with no divider, no
  legend and no label. The chart's whole comparison is invisible without
  colour, and there is no y axis and no value labels: every magnitude is
  hover-only in a `<title>` on a non-focusable `<rect>`.
- **high** `RevenueBars.svelte:47` `aria-label="Revenue by month for the
  last 24 months"` names the chart and carries no data. `SalesChart:63`
  does it properly with the window, the total and the peak.
- **high** `SectionSkeleton.svelte:14, :25` The `.sr-only` "Loading
  {title}" is **inside** the `aria-hidden` subtree, so a screen reader is
  told nothing while six sections of an account page load. The sibling
  `TableSkeleton` gets this right.
- **medium** `+page.svelte:108-141` None of the five figures says as of
  when. "This year" is year to date through `nl.today()` and does not say
  so.
- **medium** `+page.svelte:113` The "Last year" tile has no comparison
  while every other tile has one.
- **medium** `+page.svelte:159` `Promise.all([timeline, contacts])` makes
  the activity section wait for the slower of two queries, and contacts is
  awaited separately below, so the people panel could have rendered.
- **medium** `Timeline.svelte:61-128` No visible label on any control: the
  kind picker is a `role="group"` of buttons, three selects hide their
  labels in `.sr-only`, and the textarea has **no label at all**, only a
  placeholder that changes with the selected kind.
- **medium** `Timeline.svelte:104` `datetime-local` with no default and
  nothing saying that empty means now.
- **medium** `Timeline.svelte:66-76` `aria-pressed` on a group of
  mutually exclusive choices, where `AccountsTable` uses `aria-current` on
  the identical visual. Two semantics, one look.
- **medium** `ContactList.svelte:44, :106, :195` and
  `VendorContacts:130` Cancel removes its own button, so focus falls to
  `<body>`. Opening a form does not move focus into it, so a keyboard user
  presses "Add contact" and nothing appears to happen.
- **medium** `ContactList.svelte:73-98` Native validation only: no
  `aria-invalid`, no per-field message, and the server already knows which
  field failed (`forms.ts:158`) and does not say.
- **medium** `NextStepList.svelte:112-120` Every Done button shares one
  `busy` flag, so submitting one disables all of them with no indication
  which is saving. And each is named "Done".
- **medium** `AccountDeals.svelte:60-92` Six `<th>` with no `scope`, and
  the quotes list is capped at 20 and the commitments at 40, both silent.
- **medium** `AccountOrders.svelte:93` `moneyExact` on Freight and
  Subtotal, `money` three rows up, in one panel.
- **medium** `AccountOrders.svelte:105-110` `--bucket-*` redefined from
  `--status-*`, duplicating `OperationsBoard`.
- **medium** `RevenueBars.svelte:17` `Math.max(1, ...)` means an account
  with no revenue draws 24 bars against a fabricated maximum of $1, with
  no y axis to tell a $1 world from a $1M one.
- **low** `+page.svelte:125` `.num` on a date inside `.figures dd` which
  sets `text-align: left`: two rules fighting, and the right-align loses.
- **low** `+page.svelte:30-35` `trend()` reimplemented in
  `AccountsTable:34-42` with different wording and a 3% deadband this copy
  lacks. Two trend functions, two vocabularies.
- **low** `ContactList.svelte:98` Notes is an `<input maxlength="1000">`.
- **low** `ContactList.svelte:128` Edit, repeated once per contact, with
  no record in its name.
- **low** `NextStepList.svelte:191-193` An overdue step is marked by a 2px
  amber shadow and the word "overdue" in the smallest type on the panel.
- **low** `AccountDeals.svelte:101` `{draft.status}` prints the raw enum
  where every other status goes through a label map.
- **low** `Timeline.svelte:144` Author, outcome and timestamp are joined
  by CSS `::before` middots, so a screen reader reads them with no
  separator.
- **positive** `+page.server.ts:30-31` The header is awaited because it
  decides between a page and a 404; everything else streams, and the
  comment says why. This is the right blocking shape.
- **positive** `AccountDeals.svelte:34` "$340K of $500K" with `.num` on
  the wrapper is the comparison done right.

### `/parts` and `/parts/<item_no>`

- **high** `parts/+page.svelte:97-127` Eight `<th>` with no `scope`, no
  sticky header, 100 rows in one chunk, no pagination and no
  virtualization. The cap is disclosed; there is no way to see row 101.
- **high** `parts/+page.svelte:41-52` The family select's loading fallback
  is `<select disabled><option>Family</option></select>`: no disabled
  styling, no `aria-busy`, and its one option reads as a chosen value. A
  screen reader hears "Family, Family, disabled".
- **high** `parts/[item]/+page.svelte:177-201` and four more panels Five
  capped lists (10 buyers, 15 lines, 20 commitments, 20 quotes, 12
  siblings) with no total and no disclosure, on a page that discloses
  correctly for open lines at `:256`. A part with 200 buyers presents its
  top 10 as the whole list.
- **high** `parts/[item]/+page.svelte:250` One `TableSkeleton rows={5}`
  stands in for three panels that arrive together, so the page jumps
  several hundred pixels.
- **high** `parts/[item]/+page.svelte:445-483` A second stat tile design,
  two `.figures` strips and a `.warn` variant.
- **high** `SalesChart.svelte:24` `Math.max(m.units, 0)` draws a negative
  month at height zero, pixel-identical to a month with no sales, while
  the hover title reports the negative figure.
- **high** `SalesChart.svelte:112-119` The current month is
  `--text-muted` against `--text-faint` bars: a one-step grey difference,
  effectively invisible, and unlabelled.
- **medium** `parts/[item]/+page.svelte:68` `aria-label="Price, cost and
  sales"` on a panel with **no visible heading at all**: eight figures in
  two strips with no title, while every other panel on the page uses
  `aria-labelledby` pointing at a visible `<h2>`.
- **medium** `parts/[item]/+page.svelte:131-141` "Projected available"
  turns amber and the sub-line reads the same whether or not the reorder
  point is breached. Colour is the only signal.
- **medium** `SalesChart.svelte:58` The peak label is a bare number with
  no unit, and there is no zero label and no gridline. The `aria-label`
  says "units"; the visible chart does not.
- **medium** `SalesChart.svelte` No comparison series and no reference
  line: 24 bars and nothing to judge them against.
- **medium** `parts/[item]/+page.server.ts:15-20` Two serial round trips
  before any HTML, including the common case where the item number is
  already canonical. Same at `vendors/[vendor]/+page.server.ts:19-26`.
- **medium** `parts/+page.svelte:74` Apply is not primary, and with
  `onchange` auto-submit on four of six controls it is only reachable
  without JavaScript.
- **medium** `parts/+page.svelte:134` The retry link is `/parts`, which
  discards every filter.
- **low** `SalesChart.svelte:138-147` `:first-child { left: 0 !important }`
  and `:last-child { right: 0 }`: when there is one tick it is both, and
  `:last-child` wins, pinning the single label to the wrong edge.
- **low** `parts/+page.svelte:122` A margin percentage with no denominator
  named, where the sort label already says "Gross margin".
- **low** `parts/[item]/+page.svelte:366` `Other {n} {family} parts`
  renders as `Other 8" chrome parts`, which reads as a count of 8.
- **low** `parts/+page.svelte:27` "Every part in the item master" is ERP
  vocabulary in body copy, as are three 404 messages.
- **positive** `parts/[item]/+page.svelte:112-114` "Where this number came
  from", linking to the warehouse ledger, is the best provenance
  affordance in the app. It exists on exactly one figure out of forty.
- **positive** `parts/+page.server.ts:13-20` Nothing awaited, both queries
  stream. The reference shape.
- **positive** `SalesChart.svelte:63` A text alternative that names the
  window, the total and the peak. The standard the other chart should meet.

### `/vendors` and `/vendors/<vendor_no>`

- **high** `vendors/[vendor]/+page.svelte:107-134` `getVendorParts` has
  **no LIMIT**. This page renders one row per part for the vendor with no
  cap, no pagination and no virtualization, in a 32px-row table with no
  sticky header. It is the row ceiling for the whole app.
- **high** `vendors/+page.svelte:58-93` Seven `<th>` with no `scope`, no
  sort control at all, and a header that asserts a sort the user cannot
  change. 100 rows, no pagination.
- **high** `vendors/+page.svelte:107-112` A fourth copy of the list-page
  shell, byte for byte the same as `/parts` except one rule.
- **high** `vendors/[vendor]/+page.svelte:180-206` A third `.figures`
  design with a `.warn` that duplicates the parts page's.
- **medium** `vendors/+page.svelte:31-33` "Include vendors with no parts"
  has no auto-submit, unlike the identical checkboxes on `/parts`.
- **medium** `vendors/+page.svelte:77` `place(city, state, 'US')`
  hardcodes the country, so a Canadian vendor renders as a US one. Same in
  `/search` and on the vendor page.
- **medium** `vendors/[vendor]/+page.svelte:145` `max-width: 1080px`
  against 1180px on its own list page and the two other detail pages.
- **medium** `vendors/[vendor]/+page.svelte:63-78` No as-of and no source
  on "Revenue 12m" or "Below reorder point".
- **medium** `vendors/[vendor]/+page.server.ts:43-47` The raw zod message
  reaches the UI: "String must contain at most 80 character(s)". The
  accounts feature already has a field-to-sentence map.
- **low** `vendors/[vendor]/+page.svelte:28-49` Six facts default to "not
  stated" while the tables on the same page use "·".
- **positive** `VendorContacts.svelte:51` The best empty state in the app:
  one line, one button, "Add the first contact".

### `/search`

- **high** `+page.svelte:26-33` The page's main input is `font-size: 1rem`,
  which is 13px, so iOS zooms the viewport on focus. Measured: **13px on
  both search fields**.
- **medium** `+page.svelte:39-58` Both no-results states are two-sentence
  paragraphs with no action, on a page that knows how to build the link
  (`:108`).
- **medium** `+page.svelte:106-112` "See all N in the parts list" exists
  for parts only. Accounts is capped at 10 with "3 of 41" shown and no way
  to see the other 38, even though `/accounts` takes a `q`.
- **medium** `+page.svelte:69-82` Results are three unlabelled spans; on a
  375px screen an account row shows a truncated city and nothing else.
- **low** `+page.svelte:193-204` `.row` has hover but no `:active`, and
  8px padding gives a 31px tap target under a comment claiming it is
  "easy to hit on a phone".
- **positive** `+page.server.ts:10-17` Returns without touching the
  database when there is no query, and streams the three groups otherwise.

### `/operations`

- **high** `UploadPanel.svelte:149-158` `.drop` is styled as a
  drag-and-drop zone with a dashed border. There is **no `ondrop` or
  `ondragover` handler anywhere in the repo**. Files dropped on it
  navigate the browser away. The affordance is a lie.
- **high** `UploadPanel.svelte:123, :127, :273` The sample hint is a
  visible span **and** a `title`, and at 720px the span is
  `display: none`, leaving the `title` as the only carrier. No touch and
  no keyboard user can read it.
- **high** `OperationsBoard.svelte:180-218` The day-over-day table is
  capped at 15 rows per change kind, the page prints the true totals just
  above it, and says nothing about the truncation. Every other capped
  table in this feature discloses its cap.
- **high** `OperationsBoard.svelte:133-138, :198` Record names are plain
  text here while the forecast page one click away links both the customer
  and the part. `riskLines` already carries `customerNo`.
- **high** `OperationsBoard.svelte:87-91` A four-segment share bar with
  `aria-hidden="true"`, no axis, no legend, no labels and no percentages.
  Decoration standing where a comparison belongs, and the app already owns
  an accessible bar with a reference mark.
- **high** `OperationsBoard.svelte:134` Bucket status is an 8px coloured
  dot plus a `title`: colour-only for a sighted user, title-only on touch,
  and a non-focusable `<span title>` is not reliably announced.
- **high** `SnapshotReview.svelte:383-388` A 360px scrolling table with
  **no sticky header**, unlike the five other scrolling tables in the
  feature. Scroll 100 error rows and the columns are anonymous.
- **high** `SnapshotReview.svelte:412-420` `.button.danger` is defined
  **only here**, in one component's scoped block. That is why the
  assistant's "Reject for good" has no visual distinction.
- **high** `SnapshotReview.svelte:232-244` Clicking Discard removes the
  button that was clicked, so focus falls to `<body>`. Same bug in
  `ProposalCard:124` and `RuleEditor:118`.
- **high** `SnapshotReview.svelte:226` The only explanation of why Release
  is disabled is a `title` on a disabled button.
- **medium** `operations/+page.svelte:34-37, :91-101` A second segmented
  control, hand-rolled, and it exists on `/operations` only: from
  `/operations/forecast` the way back is an inline sentence.
- **medium** `OperationsBoard.svelte:166-178` The three day-over-day
  figures carry no unit. "New: 34" is 34 what?
- **medium** `SnapshotReview.svelte:203-212` The note is required (the
  server rejects it and the button is gated on it) and the input has no
  `required`, no `aria-required` and no inline validation.
- **medium** `OperationsBoard.svelte:292-385` Two stat tile designs in one
  file.
- **low** `OperationsBoard.svelte:441-453` and `SnapshotReview:431` The
  snapshot file name is `display: none` on phones with no fallback.
- **positive** `+page.server.ts:61-77` The best error handling in the
  codebase: no file, too big (with the actual MB and the limit), and a NUL
  byte detected with "Export the report as CSV, or save the spreadsheet as
  CSV first."
- **positive** `OperationsBoard.svelte:157-161` "Snapshot #13 against #12"
  names its own comparison, with a first-snapshot fallback.
- **positive** `OperationsBoard.svelte:53-58` "From snapshot #13, applied
  8:04 AM by Dana" is source and as-of done right. It should be copied to
  the forecast and warehouse boards, which have neither.

### `/operations/forecast`

- **high** `+page.svelte:28-30` **A wrong number is shown during load.**
  The pending branch passes `lineCount={0}`, so the filter bar reads
  "0 lines" as a confident figure while the projection is still computing,
  and it passes empty option arrays, so the three selects silently offer
  only "Any vendor".
- **high** `ForecastBoard.svelte:143-319` Five panels capped at 8, 8, 8,
  10 and 12 rows, **none disclosed**. "Vendor call sheet: customer dollars
  waiting on each vendor" reads as complete.
- **high** `ForecastBoard.svelte:47-85` No as-of on the headline figures.
  `forecast.today` is in the payload and is passed to `ShipCheck`, and is
  never displayed. "Projected late $412,000" floats with no date.
- **high** `ShipCheck.svelte:78-123` **Dates render without a year.** All
  five `day()` calls omit the year argument, and `format.ts:41` returns the
  bare "Mar 3" when it is undefined. An availability date in the next
  calendar year is indistinguishable from this year, on the one screen
  whose whole job is telling a customer a date on the phone. Same at
  `RuleActivity:104`.
- **high** `ShipCheck.svelte:153-156` Three inputs at 13px, so iOS zooms.
  Part number and date are what a phone user actually types.
- **medium** `ShipCheck.svelte:62` The quantity box is pre-filled with 10
  with no explanation.
- **medium** `ForecastFilters.svelte:102-104` Five selects at 13px (iOS
  zooms) and 28px tall.
- **medium** `ForecastBoard.svelte:32-44` `withFilter()` rebuilds the
  query string by hand, duplicating the shape `forecast.ts` already owns.
- **medium** `ForecastBoard.svelte:373-406` A fourth stat tile design.
- **low** `ForecastFilters.svelte:78` and `ForecastBoard:91` Raw numbers
  where every other figure on the page is comma-grouped.
- **positive** `ForecastFilters.svelte:29-82` **The best URL state in the
  app.** Plain `method="GET"`, five filters in the query string, works
  with JavaScript off, `data-sveltekit-keepfocus`, and an explicit Apply
  kept for keyboards. Every view is a link.
- **positive** `ForecastBoard.svelte:95-99` The best empty state in the
  app: one line and a real next action that is a **link**, so an agent can
  follow it.
- **positive** `reason.ts:23-40` "waiting on PO-104471 from Beacon
  Plating, due Oct 3" is a derived figure that states its derivation.
- **positive** `ShipCheck.svelte:74-83` The verdict leads with "Yes:" or
  "No:" in words and spells out the basis. Readable without colour.

### `/warehouse`

- **high** `PartLedgerPanel.svelte:88` **A raw database identifier is
  shown to a warehouse user**: "These do not agree. `nl.warehouse_drift()`
  reports it." The worst microcopy in the app, in the one message a floor
  user will escalate on.
- **high** `WarehouseToday.svelte:44-48` A second decorative share bar,
  `aria-hidden`, six colours in a 4px strip, no labels.
- **high** `WarehouseToday.svelte:18-25` The panel is titled "On the floor
  today" with **no date anywhere**. `board.today` is in the payload and is
  passed to two children. A stale tab reads as current.
- **high** `PickQueue.svelte:94-97` Twenty shipments give twenty buttons
  whose accessible name is "Ship it".
- **high** `PickQueue.svelte:104-130` The nested lines table has no sticky
  header and no max-height, so a 40-line shipment pushes the next
  shipment 1300px down, and there is no way to collapse one.
- **high** `PartLedgerPanel.svelte:135-141` "Correct" with no
  `type="button"`, no record in its name, and no `aria-controls` to the
  row it reveals.
- **high** `PartLedgerPanel.svelte:153-176` The correction form's three
  inputs and a select at 13px: iOS zooms while a person is correcting
  stock in the aisle.
- **high** `PartLedgerPanel.svelte:155-163` The quantity field has no help
  text and no inline validation. `min={-b.quantity}` silently caps it and
  `placeholder="-2"` is the only hint that a negative is expected.
- **high** `CountSheet.svelte:81-102` The post button is the fourth child
  of a `<dl class="figures">`, a `<div>` that is neither `dt` nor `dd`:
  invalid content model, and the primary action looks like a figure.
- **high** `WarehouseSkeleton.svelte:9-52` Three stacked panels standing
  in for up to five, one of which is a two-column row, so the layout
  reflows when data lands. And `PickQueue` rows are a header plus a nested
  table, three to eight times the 34px modelled.
- **high** `RecentMoves.svelte:127-131` `.desc { display: none }` on
  phones **deletes the item description entirely** with no fallback. A
  picker reading "L3515-630SC" with no description is the mobile failure
  case this business cannot afford.
- **medium** `warehouse/+page.svelte:54-89` There is no view switcher, so
  a phone gets five stacked panels including a 40-row table, and nothing
  can be linked to.
- **medium** `WarehouseToday.svelte:10-15` `totalPieces` and `totalValue`
  are summed client side from six tiles and presented in the panel head as
  authoritative, with no label saying so.
- **medium** `TransitList.svelte:1-42` The only panel with no row cap, no
  scroll container and no table: an unbounded `<ul>`.
- **medium** `RecentMoves.svelte:48-50` A negative move is greyed to
  `--text-muted`, so colour says "less important" where the sign says
  "outbound".
- **medium** `CountSheet.svelte:39-47` The sort is computed client side and
  is neither stated nor controllable.
- **medium** `PickQueue.svelte:74` The only customer link in the app not
  wrapped in `encodeURIComponent`.
- **medium** `PartLedgerPanel.svelte:167-171` The reason select has no
  empty option and no `required`, so it silently defaults to the first
  reason, which is written to a permanent ledger.
- **low** `PartLedgerPanel.svelte:175` A 500-character field as a
  single-line input with no counter.
- **low** `TransitList.svelte:59-74` Hover on a non-interactive `<li>`: an
  affordance with nothing to click.
- **positive** `PartLedgerPanel.svelte:59-91` The arithmetic laid out as
  arithmetic, opening plus moves equals closing, beside the item master
  figure, with a verdict. The best "explain this number" pattern in the
  app.
- **positive** `warehouse/+page.server.ts:76-108` Success messages state
  the consequence: "+3 on L3515-630SC at MAIN: the bin holds 47, on hand
  is 512."
- **positive** `WarehouseToday.svelte:30` Each bucket carries a
  plain-English hint: "On the dock, waiting for the truck."

### `/automations`, `/automations/new`, `/automations/<id>`

- **high** `RuleEditor.svelte:74-102` **The entire rule draft lives in
  component state**: nine fields, nothing in the URL, no persistence. A
  reload loses a half-built rule and no link can open a pre-filled editor.
  This is the biggest deep-link gap in the app.
- **high** `RuleEditor.svelte:161-320` **The editor is non-functional
  without JavaScript** while the rest of the app degrades. The real
  payload is a hidden `rule` JSON field; the radios are named
  `trigger-choice` and are never read by the server, and every text field
  is `bind:value` with no `name`. With JavaScript off it posts the
  render-time JSON and silently discards every choice.
- **high** `automations/[id]/+page.server.ts:11` **Fully blocking, and the
  only page in the app with no loading state at all.**
  `Promise.all([getRule, listPeople])` where `getRule` pulls the rule plus
  10 runs plus 25 firings.
- **high** `automations/[id]/+page.svelte:26-28` `?saved` is read and
  never removed, so reloading or sharing the URL re-announces "Saved."
  for ever.
- **high** There is **no way to delete a rule**: no action, no control. A
  mistaken rule can only be switched off and left in the list.
- **high** `automations/+page.svelte:40-67` No filter, no sort, no search,
  and the list is unbounded. With 40 rules there is no way to see only the
  failing ones and no link can express it.
- **high** `RuleEditor.svelte:118-124` Removing a condition removes the
  focused button, so focus falls to `<body>`, once per condition.
- **high** `RuleEditor.svelte:704-718` The 16px mobile rule is **scoped to
  this component**, so it does not reach `TemplateField`'s textarea, which
  is the longest thing anyone types here. iOS zooms on it.
- **high** `TemplateField.svelte:63-65` What the placeholder buttons
  insert is **only in a `title`**. On touch there is no way to learn that
  "Customer name" inserts `{customer}`; braces just appear in the text.
- **high** `TestResults.svelte:28` `aria-live="polite"` on a section
  containing a whole table, so the entire grid is read aloud when results
  arrive.
- **high** `RuleActivity.svelte:104` `day(f.dueOn)` with no year: a due
  date rolls into next year invisibly.
- **medium** `RuleEditor.svelte:193-208` A hand-rolled `role="switch"`
  with an 18px track, the only switch in the app.
- **medium** `RuleEditor.svelte:313-322, :621-639` `.segmented` re-skinned
  because it is built from labels, duplicating the `[aria-pressed]` rule
  verbatim. Third variant.
- **medium** `RuleEditor.svelte:131-135` The issues list swaps source on
  `attempted`, so a server-reported problem disappears when the user
  presses Test again even if unfixed, then reappears.
- **medium** `RuleEditor.svelte:222-313` `role="radiogroup"` on plain divs
  wrapping labels, with `aria-labelledby` pointing at text reading
  "1 When", so the group announces as "1 When, radio group".
- **medium** `RuleEditor.svelte:344-350` "2 things need fixing above" with
  no link to the offending fields.
- **medium** `RuleEditor.svelte:655-672` `backdrop-filter` on a sticky
  element inside a scroller, with no `@supports` fallback and a
  translucent background if the blur fails.
- **medium** `RuleActivity.svelte:38` "Run now" writes real next steps
  with no confirmation, styled as a neutral button, and the
  saved-versus-edited distinction is title-only.
- **medium** `RuleActivity.svelte:58-109` Two lists of tabular data as
  wrapping flex rows: no `<th>`, no alignment, no tabular figures.
- **medium** `automations/+page.svelte:54-60` Four facts in one unlabelled
  faint fragment: "Last run 8:02: 3 new of 51". 51 what?
- **medium** `automations/+page.svelte:44-48` The most important state on
  the row, On or Off, is the faintest text on it at 11.05px.
- **medium** `automations/new/+page.server.ts:10-25` The starter rule
  pre-fills conditions and nothing says they are an example.
- **low** `RuleEditor.svelte:435` `.step-no { font-size: 0.75rem }`,
  measured at **9.75px**: the smallest text in the app.
- **low** `RuleEditor.svelte` Three sizes for the same class of secondary
  text in one file: 0.85, 0.88, 0.88 rem.
- **positive** `RuleEditor.svelte:168-171` "This rule reads: ..." as a
  live plain-English sentence above the form. The user can read what they
  built.
- **positive** `RuleEditor.svelte:126-135` Client validation runs the same
  `ruleSchema` the server runs, so what shows inline is what the server
  would say.
- **positive** `RuleEditor.svelte:173-189` Read-only viewers get a
  disabled fieldset plus prose, with the hidden fields outside it so a
  test still submits.
- **positive** `RuleEditor.svelte:158, :374` `testIsStale` compares the
  tested JSON against the current JSON and dims the results with an
  explanation. Very few apps do this.
- **positive** `ConditionRow.svelte:88-97` The only icon-only control in
  the app that is fully named: `type="button"`, `aria-label="Remove
  condition 1"` and a `title`.
- **positive** `ConditionRow.svelte:182-208` A phone layout that
  repositions the joiner and the remove button and gives each control a
  line, with a comment. Real mobile design, not a reflow.

### `/rfq` and `/rfq/<id>`

- **high** `rfq/+page.svelte:87-95` The textarea, the feature's primary
  input, at 13px. Measured: every field in this feature is 13px.
- **high** `rfq/[id]/+page.svelte:48-55` "Tokens: 812 in · 140 out · 0
  cached" in the header facts of a sales screen.
- **high** `rfq/[id]/+page.svelte:110-131` plus `DraftLines:108` Three or
  more buttons named "Use" and "Use this account" on one page. An agent
  asked to "use account 40118" sees three candidate targets.
- **high** `DraftLines.svelte:181-186` Eight lines give eight buttons
  called "Remove line", eight called "Use" and eight called "Set". The
  line number is on the wrapping form's `aria-label`, which does not name
  the button.
- **high** `DraftLines.svelte:183` "Remove line" is `.button quiet`, the
  quietest variant in the system, for the only destructive action on the
  page, while the benign "Quote at our price" is a full `.button`.
- **high** `DraftLines.svelte:316-375` On a phone `table, tbody, tr, td {
  display: block }` **strips table semantics from the accessibility
  tree**, `thead` is hidden, and the replacement column labels are CSS
  `::before` content at 10.1px, which is not reliably announced. The phone
  view of the parts table is unreadable with a screen reader.
- **medium** `rfq/[id]/+page.svelte:127` Placeholder as label, no visible
  label, no `autocomplete`, 140px wide. Same at `DraftLines:99` and
  `:125`.
- **medium** `rfq/[id]/+page.svelte:68-70` Warnings render with
  `role="note"`, which is not a live region, so warnings that appear after
  a revise are silent.
- **medium** `rfq/[id]/+page.svelte:22, :139` "87% sure" next to the
  sender's email, with no explanation of whose confidence it is or what to
  do at 60%.
- **medium** `rfq/+page.svelte:47-50` "Live: claude-..." and "Rules
  extractor" put a model id and an internal component name in front of a
  salesperson.
- **medium** `rfq/+page.svelte:72-77` Loading a sample only mutates state,
  so "load sample 03" cannot be handed to anyone as a link, and the select
  has no `name`.
- **medium** `rfq/+page.server.ts:32` The full text of every eval email
  ships in the page payload on every load.
- **medium** `rfq/+page.svelte:105-108` "Read and check" is enabled with
  an empty textarea; submitting costs a round trip to learn the server's
  refusal.
- **medium** `rfq/+page.svelte:187` The catch says "Reload the page to try
  again" with no control, while `/commitments` gives a working button for
  the same situation.
- **medium** `ProposalCard.svelte:123-126` "Reject for good" is a plain
  `.button` for an irreversible decision.
- **medium** `ProposalCard.svelte:102-130` The reject form appears with no
  focus move, so a keyboard user's focus is left on a button that has just
  been removed.
- **medium** `CheckBadge.svelte:15` In compact mode, used in four panel
  heads, the entire justification for "Needs review" is a `title` and is
  unreachable on touch.
- **medium** `ChangeForm.svelte:62-65` `pointer-events: none` plus
  `opacity: 0.6` while saving: a keyboard user can still tab in but a
  mouse user cannot click, and nothing is announced.
- **low** `rfq/[id]/+page.svelte:394` The raw email is 0.85rem with
  `.mono` compounding to **10.2px**, for the text a person is being asked
  to check the draft against.
- **low** `DraftLines.svelte:54` The email's own words are truncated to
  220px with the full text only in a `title`. That is the evidence.
- **low** `rfq/[id]/+page.svelte:106` "Customer not settled" reads like
  billing status for "we do not know which account this is".
- **low** `rfq/[id]/+page.svelte:188` "No date (90-day window)" puts the
  rule in a parenthesis on the button face.
- **note** The name "RFQ draft" is jargon and the owner has already said
  so. It is in the nav, three page titles, the breadcrumbs and about
  thirty strings. Rename it "quote request", which is the planned change
  in `docs/handoff.md`.
- **positive** `ProposalCard.svelte:46-91` The proposal states exactly
  what approval creates, and Approve is disabled until nothing needs
  review. The model for how the rest of the app should gate a commit.
- **positive** `ChangeForm.svelte:45-49` The row version and the request
  id ride with every change, so a stale page cannot write twice.
- **positive** `rfq/+page.svelte:296-313` `.pressable-row` is the one
  control in the app with rest, hover, active and a 44px target.

### `/ask` and `/ask/<id>`

- **high** `ask/+page.svelte:7, :70` The conversations list borrows
  `rfq/DraftListSkeleton`, whose `aria-label` is literally **"Loading
  recent drafts"**. A screen reader user on the Ask page is told the app
  is loading RFQ drafts.
- **high** `AskBox.svelte:75-81` **No stop control while the assistant is
  working.** The button reads "Thinking..." and disables; there is no
  cancel, no abort and no timeout affordance. On a live call that is thirty
  seconds with no escape.
- **high** `AskBox.svelte:96-99` The textarea at 13px, so iOS zooms on the
  primary input of the feature.
- **high** `ask/+page.svelte:54-61` Clicking a starter question writes to
  state only. The four questions that are the app's own demo path are not
  linkable.
- **high** `ProposalCard.svelte:115-118` "Reject for good" is styled the
  same as Cancel beside it. `.button.danger` exists and is locked in
  another component.
- **high** `ProposalCard.svelte:122-127` Clicking Reject removes that
  button, so focus falls to `<body>`.
- **high** `ProposalCard.svelte:50-54` Options keyed by array index, and
  the raw tool call (`add_next_step({"commitmentId":412,...})`) is the
  option's only detail.
- **high** `ModeBadge.svelte:56` A **hardcoded `id`** on the passphrase
  input, where every sibling uses `$props.id()`. Two badges on one page
  would break the label association.
- **high** `ModeBadge.svelte:37-40` The "Turn off" button has no pending
  state at all: no disabled, no `aria-busy`, no callback. A double click
  sends two lock requests.
- **medium** `AskBox.svelte:30-35` Enter submits and Shift+Enter
  newlines, and nothing on screen says so.
- **medium** `Conversation.svelte:16-17` No `aria-live` and no focus move
  when a new turn appears, so a screen reader user must hunt for the
  answer.
- **medium** `ask/[id]/+page.svelte:40-44` "12 of 30 messages · 9 more
  questions fit here" divides by two with no explanation that a question
  plus an answer is two messages.
- **medium** `ask/[id]/+page.svelte:31-35` A nonexistent conversation
  renders **200 with a panel** rather than a 404.
- **medium** `ask/[id]/+page.svelte:112-127` The sticky compose box is
  static on phones, which is where a sticky compose box matters most.
- **medium** `ModeBadge.svelte:61-63` A failure announced as `status`
  rather than `alert`, coloured `--danger` with no icon and no prefix.
- **medium** `Lookup.svelte:41` A raw millisecond figure with no
  comparison, presented to a salesperson.
- **medium** `ask/+page.svelte:98-101` and `ask/[id]:70-72` Two catches
  that tell the user to reload in prose while four others render a button.
- **low** `Conversation.svelte:84-86` `.when` at **10.66px**.
- **low** `Lookup.svelte:59-64` A 30px disclosure with the marker
  suppressed and no rotation indicator: open and closed look the same.
- **low** `ask/+page.svelte:51` "All four work in scripted demo mode" is a
  static claim about an imported array's length.
- **positive** `ask/+page.svelte:29-32` The trust model in three short
  sentences: "Anything that changes a record it can only propose, and you
  approve it."
- **positive** `Conversation.svelte:31-47` "What it looked up" with a
  count, and a `chip warn` reading "1 gated, not run" when a gated tool
  was requested. Showing the refused call is the honest choice.
- **positive** `ProposalCard.svelte:73-76` The shown tool and input are
  posted back, the server compares them with the stored proposal and
  refuses on a mismatch, and writes from the stored copy. The right way to
  build an approval gate.
- **positive** `ProposalCard.svelte:129-145` "Written 3:12 PM by you,
  through the same function the pages use."

### The error page and the 404 path

- **high, was** `+error.svelte:15` One action, always "Back to
  commitments", which is the wrong destination from an operations URL, and
  no retry at all. A 500 from a slow query left the person with a status
  code and a link to somewhere else. **Fixed**, see below.
- **medium** `hooks.server.ts:17` `/llms.txt` is not in `PUBLIC_PATHS`, so
  the file added in this branch redirects to `/signin`. One line to fix,
  and the file is in a server file I must not edit. Instruction below.

### Three findings that only the browser showed

**A. The desktop rail scrolls its own icons out of view on every
navigation. High. `+layout.svelte:136-141`. Fixed.**

```js
if (!rail || rail.scrollWidth <= rail.clientWidth) return;
rail.querySelector('[aria-current="page"]')?.scrollIntoView({ inline: 'center', block: 'nearest' });
```

The effect was written for the phone bottom bar. Its guard is
`scrollWidth > clientWidth`, which is **also true on a desktop**: the rail
is 52px wide with 216px of label content clipped by `overflow: hidden`. So
on every desktop navigation the rail is scrolled sideways to centre the
current item, and the icons go off screen. Screenshots of
`/automations/new`, `/warehouse`, `/accounts` and `/parts` show an empty
rail with only the current item's grey background at the left edge. It is
the first thing a viewer sees and it looks broken.

The same call has a second effect: `scrollIntoView` moves the browser's
sequential focus navigation starting point. **Measured: on 18 of 22 pages
the first Tab press lands in the middle of the rail**, exactly one item
past the current section, rather than at the top of the document. The four
that behave are the ones where the item was already centred. A skip link
added above this would never be reached.

Fixed: the effect now runs only when `matchMedia('(max-width: 720px)')`
matches, and sets `scrollLeft` arithmetically instead of asking an element
to scroll itself.

**B. Eleven of twenty-one pages scroll sideways on a phone. High.
Partly fixed.**

| Page | Document width at 375px | The widest thing, and how wide |
|---|---|---|
| `/operations/forecast` | 930px | `header.head` 918px, `form.filters` 918px, `section.panel` 918px |
| `/operations` | 824px | `header.head` 812px, `nav.tabs` 812px, `section.upload` 812px |
| `/parts` | 743px | `header.head` 731px, `form.filters` 731px, `section.panel` 731px |
| `/vendors/<no>` | 667px | `header.head` 655px, `div.title-row` 655px, `dl.facts` 655px |
| `/warehouse` | 653px | `header.head` 640px, two `section.panel` 640px |
| `/vendors` | 588px | `header.head` 576px, `p.faint` 576px, `form.filters` 576px |
| `/accounts/<no>` | 530px | nothing outside a scroller |
| `/commitments/answer` | 521px | nothing outside a scroller |
| `/parts/<no>` | 493px | `header.head` 481px |
| `/commitments/<id>` | 418px | nothing outside a scroller |
| `/automations/<id>` | 399px | nothing outside a scroller |

The mechanism is one CSS default. Every page's container is
`display: grid`, and a grid item's `min-width` is `auto`, so one child
that cannot shrink (a `table` with a `min-width`, a flex row of `flex:
none` items, a `repeat(auto-fit, minmax(340px, 1fr))` track) grows the
track, which grows the page, which grows every sibling with it. That is
why `header.head` measures 918px on a 375px screen: it is a stretched grid
item of a container that a table pushed wide. It is also why the
`.table-wrap` scrollers, which are present on all 13 wide tables, were not
doing their job: they could not shrink either.

The screenshot of `/parts` at 375px shows the header sentence cut off
mid-word, the filter row running off the right edge, and no bottom nav at
all, because the fixed rail sizes itself to a layout viewport that is now
743px wide.

Fixed for the container: `.page > *, .panel { min-width: 0 }` in
`app.css`. The remaining work is the three `minmax()` grids and the
`min-width` on the test-results table, which are in route files.

**C. Six of nine list pages have no visible page title. High.**

`<h1 class="sr-only">` on `/commitments:15`, `/accounts:36`, `/parts:25`,
`/vendors:18`, `/operations:28` and `/warehouse:32`, while `/ask:28`,
`/automations:17` and `/search:21` have a visible one. The six rely on the
topbar breadcrumb, which `+layout.svelte:572` sets to `display: none` on
phones, with a comment saying "the page's own heading already names the
section". It does not. **On a phone, six of the nine list pages have no
title anywhere.** On a desktop, the app has two title positions depending
on which page you are on, which is the comparison app's worst
inconsistency finding reproduced exactly.

### The rest of the measured facts

**Landmarks and titles.** `main=1`, `h1=1` on all 22 views. Per-record
titles throughout. **Zero skip links.** Zero `role="dialog"` and zero
`<dialog>`: there are no dialogs, so there are no focus traps to fix, and
also no focus management on any of the nine inline disclosures. Zero
`role="tab"` and zero `role="tablist"`.

**Table headers. 30 tables, 166 `<th>`, zero with `scope`.** Every table
has a header row and none tells a screen reader which axis it heads.

**Live regions.** 20 `aria-live` across 22 views, which is one per page:
SvelteKit's own route announcer. The app contributes exactly one,
`TestResults.svelte:28`, and that one is on a whole table. 39 `aria-busy`,
28 of which are the sign-in page's fourteen buttons rendering
`aria-busy="false"`. So about eleven real busy states, and none of them on
a streamed section.

**Tap targets at 375px. 31 distinct control shapes under 44px, 132
instances, and zero controls reached 44px.** `--control-h` was 28px so
every `.button` and `<select>` was 28px, and below that: the theme buttons
25x22 (63 instances), `.button.action` 58x22, `.tiny` 59x22, the activity
kind buttons 38x22 to 62x22, `a.chip.over` ("Name the buyer") 91x18, the
filter checkboxes 13x13 and 14x14, and three `<input>` elements measuring
1x1 because they are `.sr-only` proxies for a styled control.

**Fields under 16px at 375px. 14 distinct, 55 instances: every field in
the app.** 13px or 11.96px on every `input`, `select` and `textarea`,
including 22 instances of the global search box, the outcome note, the
activity note, the RFQ paste box at 11.0px, and the forecast's date,
number and text fields. iOS Safari zooms the page on focus for all of them.

**Focus visibility.** The global `:focus-visible` gives every control a
2px ring, and the measured tab order showed a ring on every stop except
four. Three of those four are fine on inspection: `SearchBox` draws the
ring on the wrapper with `:focus-within`, and `CommitmentCard .title` and
`AccountsTable .name` draw it on the stretched `::after` overlay. Worth
naming anyway, because it means those three controls have no state of
their own if the parent rule is ever scoped away. The fourth is
`Timeline`'s note field, which is also **the only control in the app with
no accessible name at all**: no label, no `aria-label`, only a placeholder
that changes with the selected activity kind.

**`data-*` attributes.** Two in the whole app: `data-theme` on `<html>`,
and `data-vite-dev-id` from the dev server. `data-label` exists in the
source on six responsive table captions and did not render on these views.

**Console.** No page errors and no unhandled rejections on any view, in
either theme or either width. The only console output was the expected 404
for the two deliberately bad URLs.

**Fonts.** Self-hosted through `@fontsource-variable`, not pulled from a
third party. The comparison app's 1.29 MB first load with third-party
fonts does not apply here.

---

## Pass 2: the same app, used by an agent

As a checklist. `[x]` met, `[~]` partly, `[ ]` missing. Detail and the
route-by-route map are in `docs/agent-map.md`.

**Reading a screen**

- `[x]` Real tables with a `thead`. 119 `<th>` elements, all styled, all
  in a real `<table>`, except the accounts list which is a `<ul>` with no
  headers at all.
- `[ ]` `<th scope>` on every header. Zero in the app.
- `[x]` Record names as links. About twenty, all to the record's canonical
  URL, so the graph can be walked by following hrefs. `OperationsBoard` is
  the exception: plain text where the data to link is already present.
- `[x]` One `<main>` and one `<h1>` per page.
- `[x]` Per-record browser titles.
- `[x]` Section anchors that work: `#answers`, `#scope`, `#lines`,
  `#quotes`, `#buyers`, `#siblings`, `#open`, `#chart`.
- `[~]` Every field labelled with a name. Three label patterns, and four
  forms whose only description is a placeholder.
- `[ ]` `autocomplete` on person fields. Present on four inputs in one
  component; absent on the other nine.
- `[ ]` Dialog roles and tab selected state. Neither exists, because
  neither widget exists.
- `[~]` Busy state on regions while loading. Measured: 3 `aria-busy` and 4
  `aria-live` across 23 views, and the account page's six streamed
  sections announce nothing because the skeleton's `.sr-only` sits inside
  its own `aria-hidden`.
- `[ ]` Row action names that carry their record. Two controls in the app
  out of about sixty.
- `[x]` No native `confirm` or `alert`. Zero.
- `[~]` No hover-only actions. Three revealed row actions, two of them
  with `tabindex="-1"`, and eleven places where a `title` is the only
  carrier of information on touch.

**Addressing a screen**

- `[x]` All list filters, sorts and page numbers in the URL. No `goto`, no
  `pushState`, no `replaceState` anywhere in the app: filters are GET
  forms.
- `[~]` All view state in the URL. Five places hide content behind a click
  with no URL: the rule draft (nine fields), the vendor contact form, the
  reject reason on both proposal cards, the export discard confirm, and the
  part ledger correction row. Plus the `/ask` starter questions and the
  `/rfq` paste box, neither of which can be handed to anyone as a link.
- `[x]` Links are anchors, so middle-click and copy-link work.
- `[~]` Filter state survives opening a record. The URL survives Back, but
  the breadcrumb goes to bare `/accounts`, `/parts` and `/vendors` and
  discards the filters.

**Acting on a screen**

- `[ ]` Stable identifiers on the things an agent must act on. Two
  `data-*` attributes exist app-wide: `data-label` on six responsive table
  captions, and `data-theme` on `<html>`. Zero `data-testid`, `data-id`,
  `data-row`, `data-action`. The 78 `id=` attributes are section anchors,
  not record handles.
- `[x]` Idempotency exposed where an agent needs it. Every write form
  carries a hidden `requestId` and the row's `expectedUpdatedAt`, so
  submitting the form an agent was given is idempotent and
  version-checked. `ProposalCard` also posts back the tool and input it
  displayed.
- `[x]` The same rules enforced for agents as for people. Every write goes
  through a SQL function that claims the request id, requires an active
  user, checks the field rules, locks on `updated_at` and writes an audit
  row. The gate is in SQL and TypeScript, never in a prompt: a gated tool
  is refused in `gate.ts:145` before its input is even parsed.
- `[x]` A workable fallback handle. Every form action is named in its own
  action URL (`?/approve`, `?/decide`, `?/adjust`).

**Calling the app**

- `[~]` Tool coverage for every domain, not just the best served. 14
  assistant tools, 12 MCP tools on `mcp-server`. **17 of 23 person-visible
  writes have no tool at all.** Whole features are invisible: RFQ intake
  (4 writes), the warehouse (4 writes), contacts (3 writes). `/warehouse`,
  `/rfq`, `/automations` list and `/ask` have no read tool either.
  `nl.export_snapshots` is not readable by any tool while `decide_export`
  can act on it, and `nl.available_to_promise` is not in the read-only
  function allowlist, so the answer an agent most wants is uncallable.
- `[ ]` A "describe the data" tool listing each view, its columns and
  their meaning. There is a prose table list in the `run_sql` description
  and nothing machine-readable.
- `[~]` Tool annotations. The assistant has none at all: `claude.ts:71`
  emits `name`, `description` and `input_schema` only. Its `risk` field is
  better than an MCP hint because it is enforced, and it is not exposed
  under any name a generic client reads. The MCP branch has `title`,
  `readOnlyHint`, `destructiveHint` and `idempotentHint`;
  `openWorldHint` is missing.
- `[ ]` Structured output schemas rather than JSON printed as text. Both
  surfaces `JSON.stringify` into a text block. No `outputSchema`, no
  `structuredContent`.
- `[ ]` Every result row carrying its own URL from one shared route
  registry. There is no route registry in `app/src/lib`. One tool on one
  branch returns one URL field (`approve_at`).
- `[ ]` Source and as-of on every figure returned. `as_of` exists on one
  table in the schema and surfaces in one tool. The system prompt asks the
  model to say where a number came from, which is prompt-level, not
  data-level.
- `[ ]` Machine-readable errors. `errors.ts` maps `NL401` to `NL429`
  correctly and every route then calls `fail(status, { message })` and
  drops the code. Zero `+page.server.ts` returns a code or a field name.
  Inside the tool loop a refusal becomes `{ error: "<sentence>" }`.
- `[ ]` Saved routines published as reusable prompts. Automation rules are
  already named, parameterised routines and are not exposed as prompts.

**Finding the app**

- `[~]` A machine-readable app map with routes, contents and URL
  parameters. Added in this branch: `app/static/llms.txt` and
  `docs/agent-map.md`. `llms.txt` needs one line in `hooks.server.ts` to
  be reachable without a cookie.
- `[ ]` `.well-known`, sitemap, OpenAPI or a route manifest. None. One
  JSON endpoint exists and it is the cron hook. SvelteKit serves each
  page's load data at `<route>/__data.json`, which is the de facto JSON
  API, undocumented and unversioned.
- `[~]` In-context "ask about this" entry points. `/ask` exists; no screen
  links into it with its own context.

**Watching an agent work**

- `[ ]` A stop control while streaming. `AskBox` has none.
- `[~]` An activity view of what the assistant did, with undo. The
  conversation shows what it looked up and what it proposed. The queue on
  `agent-workspace` collapses four features' approval cards into one
  shape. Neither has undo.
- `[ ]` An agent can tell what happened to its proposal. On
  `agent-workspace` the decision is stored with who and when in
  `nl.queue_decisions`, and the only reader is the `/workspace` page:
  no endpoint, no tool, and `nl_readonly` has no grant on the table. The
  two branches that would close this loop do not know about each other.
- `[ ]` An agent can see the diff when its proposal was edited.
  `edited_approved` records that a correction happened, not what it was.
- `[ ]` An agent keeps its own earlier lookups. `historyFrom` in
  `conversation.ts:209` replays message text only and drops tool calls and
  results, so the model redoes its own work on a follow-up question.

---

## The ranked twenty

Effort: **S** under a day, **M** a few days, **L** a week or more.

| # | What | Sev | Effort | What it changes for a viewer |
|---|---|---|---|---|
| 1 | **The rail scroll bug.** `+layout.svelte:139`, a guard written for phones that is true on desktop, so the rail scrolls its own icons away on every navigation and hijacks the keyboard's starting point on 18 of 22 pages. **Done.** | high | S | The nav stops looking broken. This is the first thing a viewer sees. |
| 2 | **Stop the phone scrolling sideways.** 11 of 21 pages, 7 of them because the page container itself grew to between 640 and 918 pixels inside a 375px viewport. `min-width: 0` on the page's children is **done**; the three `minmax()` grids and one table `min-width` are in route files. | high | S | The app stops being a squeezed desktop on a phone, and the bottom nav comes back. |
| 3 | **Give the six hidden `h1`s back.** `sr-only` on six of nine list pages, with the breadcrumb that was supposed to cover for them hidden on phones. | high | S | Every screen says what it is, in the same place, at the same size. |
| 4 | **Adopt the shared layer.** `app.css` now has the tokens and the classes, and `lib/components/ui/` has twelve components. Replace the 13 stat tiles, 14 page shells, 13 table wraps, 16 `.small` declarations, 7 notice rules and 4 spinners with them. | high | L | The whole product stops feeling assembled. Every following item gets cheaper. |
| 5 | **`scope="col"` on all 166 `<th>` across the 30 tables, and make the accounts list a real table.** One attribute, plus one component rewrite. | high | S | The app's densest screen becomes navigable with a screen reader, and its four unlabelled figure columns get names. |
| 6 | **Fix the wrong numbers.** `AccountOrders` sums a 50-row cap and calls it the account's open value. `RevenueBars` computes the zero line from the first bar. `SalesChart` draws a negative month at zero. `ShipCheck` and `RuleActivity` print dates with no year. `/operations/forecast` shows "0 lines" while loading. `money()` prints `-$0`. | high | M | The app stops telling a rep something untrue, on the screens they quote to a customer. |
| 7 | **Tell the truth about how many rows there are.** 14 tables show the server's first N rows and read as complete; two have no cap at all (vendor parts, and the matched invoice lines), and the three open commitment lanes are uncapped. `RowCount` discloses in one line each; the two uncapped ones need a limit and a page. | high | M | A rep stops treating a top-10 as the whole list, and a big vendor stops rendering thousands of rows. |
| 8 | **Make every record and every row action addressable.** About sixty buttons are called "Done", "Edit", "Use", "Set", "Ship it", "Correct", "Remove line" or "Answer" with no record in the name, and the whole app carries two `data-*` attributes. Put the record in each accessible name and a `data-<thing>-id` on every row, card and action target. | high | S | Twenty identical buttons become twenty different buttons, for a screen reader and for an agent. This is the cheapest agent fix in the list. |
| 9 | **Make the twelve forms real forms.** Visible labels for the four placeholder-only fields, `autocomplete` on the nine person fields, `aria-invalid` and a per-field message from the server (which already knows which field failed), `required` where the server requires it, and help text where a `title` is doing the work. | high | M | Typing into this app stops being guesswork, and a browser stops offering the rep's own address as a customer's contact. |
| 10 | **Fix focus on the nine inline disclosures.** Three drop focus to `<body>`; six never move focus in. `ConfirmButton` solves the destructive three. | high | M | The keyboard stops losing its place, and the two-step confirms become usable. |
| 11 | **`.button.danger` on every destructive action**, now that it is in `app.css`: "Remove line" (currently the quietest variant in the system), "Reject for good", "They didn't buy", "No longer there". | high | S | A rep can tell a permanent record from a save. |
| 12 | **Make the skeletons match.** Seven skeletons, **none** matching its target's panel count; one row height matching out of seven. Two stand in for the wrong feature entirely, one announcing "Loading recent drafts" on the Ask page. `SkeletonRows` takes the real numbers. | high | M | Pages stop jumping by hundreds or thousands of pixels when the data lands. This is most of what "vibe coded" looks like. |
| 13 | **One provenance component on every figure strip.** `Figure` and `Panel` take `source` and `asOf`. One figure out of roughly forty has provenance today, and one out of thirteen panels states its comparison. | high | M | Every number becomes arguable, which on a sales screen is the difference between a report and a claim. |
| 14 | **Make the three charts readable without colour.** `RevenueBars` distinguishes its two 12-month halves by fill alone with no divider, no legend, no axis and no values. `SalesChart` distinguishes the current month by one step of grey. Both share their magnitudes only through a `title` on a non-focusable rect. | high | M | The comparison the chart exists for becomes visible, in greyscale and in a screen reader. |
| 15 | **Stream the four blocking loads and give each one a skeleton.** `/automations/<id>` fully blocks with no loading state at all; `/commitments/<id>` runs five serial queries; `/accounts` blocks on two `select distinct`; `/commitments/answer` blocks and has no catch. | high | M | The four slowest screens start rendering at once. |
| 16 | **The rule draft into the URL**, plus real `name` attributes so the editor works without JavaScript. Nine fields in component state today. | high | M | A half-built rule survives a reload, and an agent can be handed a pre-filled editor. |
| 17 | **Put the code and the field into every error.** `errors.ts` already produces `NL4xx`; every route drops it at `fail()`. Same for the tool loop. | high | S | An agent can retry the right thing, and the UI can point at the field that failed. |
| 18 | **Close the three agent gaps at once**: tool cover for RFQ intake, the warehouse and contacts (17 of 23 writes have none today); one route registry so every result row carries its own URL; and structured output schemas on both the assistant and MCP. Also grant `nl.export_snapshots` and allowlist `nl.available_to_promise`. | high | L | The assistant stops being blind to a third of the app and stops being able to decide on a snapshot it cannot read, and its answers become clickable. |
| 19 | **Rename "RFQ draft" to "quote request"** everywhere, and clear the rest of the machine copy: `nl.warehouse_drift()` shown to a warehouse user, "Tokens: 812 in", "412 ms", the model id, "Every part in the item master", "Customer not settled". | medium | S | The app starts sounding like it was written for the person using it. |
| 20 | **A stop control on the assistant, and a read path for a proposal's fate.** No cancel while it is working; no way for whoever proposed something to learn what happened to it. | medium | M | The assistant stops being a thirty-second dead end, and the approval loop closes. |

Below the line, worth doing and not in the twenty: the drag-and-drop zone
that has no drop handler; the `/operations` tab strip that exists on one of
its two pages; `tabindex="0"` on the 13 scroll containers; `role="tablist"`
never used and `ProgressBar` used on one screen out of twelve; the
`repeat(auto-fit, minmax())` grids the project's own rules flag for Safari
iOS; the four places phone layouts delete content instead of reflowing it;
`?saved` that is never cleared; and no way to delete an automation rule.

---

## What I changed

Only in the five files I was allowed to touch, plus one new static file and
these two documents. The same headless browser then walked the same 22
views again, so this is measured rather than claimed:

| Measured | Before | After |
|---|---|---|
| Contrast failures, light theme | 89 distinct, worst 2.66:1 | **5**, all at 4.22 to 4.4:1 |
| Contrast failures, dark theme | 86 distinct, worst 3.32:1 | **0** |
| Phone pages scrolling sideways | 11 of 21 | **2 of 21**, and neither from the page container |
| Skip link present | 0 pages | **21 pages** |
| First Tab lands on the skip link | 0 of 22 | **21 of 22** |
| First Tab lands in the middle of the rail | 21 of 22 | **0 of 22** |
| Fields under 16px on a phone | 55 instances | **4** |
| Control shapes under 44px on a phone | 31 shapes, 132 instances | 27 shapes, **118** instances |
| Text nodes rendering under 12px | 4,127 | **2,038** |
| Distinct rendered font sizes | 15 | 19 |

Three of those need reading carefully, because they are not all wins:

- **The five remaining contrast failures are all the stacked `.faint`
  cases** and are at 4.22:1 against a 4.5:1 bar, up from 2.66:1. The
  token is fixed; the usages are in route files and are instruction 17.
- **The 118 remaining small controls are all route-declared heights**:
  `.tiny` and `.small` at 22px, `.token` at 22px, `.button.action` at
  22px. The touch override in `app.css` reaches `.button`, `.button.sm`,
  `.segmented`, `.chip`, `td` and the checkboxes, which is why the 63
  instances of the 25x22 theme button and the 13px checkboxes are gone. It
  cannot reach a class that sets its own height.
- **Distinct font sizes went up, from 15 to 19**, and that is expected
  and temporary. The scale added 12px, 15px, 17px and 21px where the
  shared classes now use them, and the 28 route-file declarations at
  11.05px and the 10 at 11.44px are still there. It gets to six once item
  4 is done. I am reporting it as it measured rather than hiding it.

### `app/src/app.css`

- **One type scale**, six steps, in px so a `rem` guess cannot drift back
  in: `--fs-meta` 12, `--fs-body` 13, `--fs-section` 15, `--fs-title` 17,
  `--fs-page` 21, `--fs-figure` 27. `h1`, `h2`, `h3`, `th`, `label`,
  `.chip`, `.eyebrow`, `.segmented` and `.panel-head h2` now come from it,
  plus `.t-meta`, `.t-body`, `.t-section` and `.t-figure` for text that is
  not a heading.
- **`.mono` no longer sets a font size.** It was `0.92em`, which
  multiplied against any smaller parent and produced 10.2px part numbers.
- **Contrast.** `--text-faint` went from `#9a948e` (measured 3.00:1 on
  white) to `#787269` (4.77:1), and from `#6f6a65` in dark (3.32:1) to
  `#8b857f` (4.87:1). `--text-muted` went from 5.68:1 to 6.57:1 so the
  three steps stay distinguishable. Both now clear 4.5:1 on `--bg` and on
  `--surface`, in both themes.
- **Two content widths**: `--width-list` 1180px and `--width-read` 720px,
  plus `--measure` for prose, and a `.page` / `.page.read` shell with
  `.page-head` so the title starts in the same place. Because the routes
  all name their container `.page`, the global rule reaches them: it gives
  `/accounts`, which had no `max-width` at all, the list width, and leaves
  the routes that set their own alone until item 4 is done.
- **`.page > *, .panel { min-width: 0 }`.** One line, and it is the fix for
  finding B: the page container can no longer be pushed wider than the
  phone it is on, and the `.table-wrap` scrollers can finally shrink and
  scroll instead of growing the document.
- **Three distinct states.** `--surface-selected` and an `.is-selected`
  rule with a left marker, so selected is not a stuck hover. `.segmented`
  gained a hover fill and its selected state now uses a two-layer
  `--raised-shadow` instead of a hardcoded black shadow that was invisible
  in dark mode.
- **Missing states.** `:not(:disabled)` on `.button:hover` and
  `.button.quiet:hover`; a real `:disabled` look for `input`, `select` and
  `textarea`; an `[aria-invalid="true"]` border.
- **Touch.** `--control-h` becomes 44px under `@media (pointer: coarse)`,
  and `.segmented > *`, `.button.sm`, `.chip`, `td` and the checkboxes
  grow with it. Checkboxes are 16px by default, 20px on touch.
- **iOS zoom.** `input, select, textarea { font-size: 16px }` under
  `@media (max-width: 720px)`, which is the fix for every field in the
  app, replacing the two local attempts (one of which was scoped so it
  missed its own child).
- **`.button.danger`**, promoted out of `SnapshotReview`'s scoped block so
  every destructive action in the app can use it. **`.button.sm`**,
  replacing four local 22px definitions. **One `.spinner`** with
  `@keyframes spin`, replacing four copies.
- **The copied patterns**, so they stop being copied: `.page`,
  `.panel-body`, `.rows` with hairlines, `.table-wrap`,
  `table.sticky thead th`, `.figures` with one stat tile, `.empty`,
  `.negative`, `.field-help`, `.field-error`.
- **`.skip-link`**, and `a.chip` / `button.chip` get control height and
  control states, because a chip that navigates is a control.
- `--radius-full` and `--touch-h` added; `--raised-shadow` added as the
  one-step-down partner to `--overlay-shadow`.

### `app/src/lib/components/ui/` (new, nothing imports them yet)

Twelve components, each with a comment saying which finding it answers.

| Component | Replaces | Answers |
|---|---|---|
| `Page.svelte` | 14 page shells, 8 widths | rules 1, 4; owns `<main id="content">`, the `<h1>` and the tab title |
| `Panel.svelte` | 10 `.body` copies, ad hoc panel heads | rules 1, 10; takes `source`, `asOf` and `busy` |
| `EmptyState.svelte` | 9 empty states, four of them paragraphs | rule 8 |
| `LoadFailed.svelte` | 13 `{:catch}` blocks, 10 with no retry | rule 14; retries the current URL with its filters intact |
| `Figure.svelte` | 13 stat tile designs | rule 10; a figure with its comparison, source, as-of, and the tone said in words as well as colour |
| `Field.svelte` | 3 label patterns, 4 placeholder-as-label fields | rule 14; wires `for`, `aria-describedby` and `aria-invalid` |
| `FormNotice.svelte` | 7 different "did it fail" predicates | one rule, `role="alert"` on failure, a conflict action |
| `SubmitButton.svelte` | 16 enhance boilerplates | disabled plus `aria-busy` plus spinner plus the record in the accessible name |
| `SkeletonRows.svelte` | 7 guessed skeletons | rule 14; takes the real rows, columns and row height |
| `Tabs.svelte` | nothing (no tabs exist) | rules 11, 12; anchors that keep every other query parameter |
| `RowCount.svelte` | 14 undisclosed caps | says how many rows are hidden, and how the visible ones were sorted |
| `ConfirmButton.svelte` | 3 confirms that drop focus | keeps a button in the same tab position and moves focus onto the step it reveals |

### `app/src/routes/+layout.svelte`

- **The rail scroll bug, finding A.** The effect that centres the current
  section now runs only when `matchMedia('(max-width: 720px)')` matches,
  and sets `scrollLeft` arithmetically instead of calling
  `scrollIntoView`. That stops the desktop rail scrolling its icons out of
  view, and stops the browser's focus starting point being moved, which is
  what was putting the first Tab press in the middle of the rail on 18 of
  22 pages.
- A **skip link** as the first thing in the tab order, targeting
  `#content` (which `Page.svelte` owns). It only works because of the fix
  above; before it, Tab never reached it.
- The **loading bar** is now a `role="progressbar"` with a name rather
  than an `aria-hidden` decoration.
- **`isCurrent()`** matches whole path segments, so `/parts/L3515` lights
  up Parts and a future `/parts-catalog` would not.
- The signed-in person's name and title are in the DOM as `.sr-only` as
  well as in the hover-only label, and the native `title` tooltip on that
  block is gone.
- The rail is named "Sections" rather than "Main", which is what it is.
- Four font sizes moved onto the scale, including the 10px phone nav label
  and the 10.66px portfolio note.

### `app/src/routes/+error.svelte`

Rewritten. It now says **what happened** (a headline per status, eight of
them), **what to try** (advice per status), gives a **retry** that reloads
the current URL with its query intact, and sends the person **back to the
section they came from** rather than always to the commitment board. A 404
and a 403 get no retry, because retrying will not help. The server's own
sentence is kept as detail under the plain one rather than used as the
headline. It uses the shared `.page read` width.

### `app/src/app.html`

A `description` meta, a comment saying why there is no `user-scalable=no`
(a person must be able to zoom; the fix is 16px fields), a `link rel="llms"`
to the new file, and the dead `<meta name="text-scale">` removed.

### `app/static/llms.txt` (new)

Short and true: how to sign in, every route with its query parameters,
what the pages give an agent, the fourteen tools and their risk classes,
and what an agent may not do. It needs one line in a server file to be
reachable, below.

---

## Ready to apply, in files I must not touch

Each one is the file, the place and the exact change.

**1. `app/src/hooks.server.ts:17`, make `llms.txt` public.** Without this
the file redirects to `/signin` and no agent can read it.

```ts
const PUBLIC_PATHS = new Set(['/signin', '/robots.txt', '/llms.txt', '/api/cron/automations']);
```

**2. `app/src/lib/format.ts:20-22`, stop printing negative zero.** Confirmed:
`money(-0.4)` returns `-$0` today.

```ts
export function money(value: number): string {
	// A value that rounds to zero from below prints "-$0", which reads as a
	// credit that is not there. Snap it to zero first.
	return dollars.format(Math.abs(value) < 0.5 ? 0 : value);
}
```

and the same guard in `moneyExact` (`Math.abs(value) < 0.005`), `count`
(`Object.is(value, -0)`) and `percent` (`Math.abs(ratio) < 0.005`).

**3. `app/src/lib/format.ts:34-36`, stop rounding across a threshold.** Add a
second function rather than changing `percent`, because most callers want
rounding.

```ts
/** 0.9461 -> 94% Rounds down, for comparing against a threshold. */
export function percentFloor(ratio: number): string {
	return `${Math.floor(ratio * 100)}%`;
}
```

Use it at `commitments/[id]/+page.svelte:114`, where `percent()` prints
"95%" while the status is not `kept`.

**4. `app/src/lib/format.ts:41`, make the year explicit.** `day(iso)` with
no `thisYear` silently drops the year, which is the bug in
`ShipCheck.svelte:78, 81, 99, 110, 123` and `RuleActivity.svelte:104`.
Either pass `year` in those six calls, or make the parameter required so
the compiler finds every caller:

```ts
export function day(iso: string, thisYear: number | 'always' = 'always'): string {
```

with `'always'` meaning "print the year". Then fix the six call sites.

**5. `app/src/lib/server/forms.ts:26-29`, keep the code and the field.**

```ts
const refusal = toAppError(error);
if (!refusal) throw error;
return fail(refusal.status, {
	message: refusal.message,
	code: refusal.code,
	field: refusal.field ?? null,
	conflict: refusal.status === 409,
	failed: true
});
```

`AppError` needs a `field` (nullable) in `app/src/lib/server/errors.ts`, set
from the SQLSTATE's message where the migrations name a column. Do the same
in `app/src/lib/server/warehouse/+page.server.ts`'s `refuse()` and in
`gate.ts:154, 218, 236` so the tool loop gets `{ code, field, message }`
instead of `{ error: "<sentence>" }`.

**6. `app/src/lib/server/assistant/tools.ts`, add annotations and an output
schema.** On `interface Tool`, next to `risk`:

```ts
	/** MCP annotations. `risk` is the enforced rule; these are the hints a
	    generic client reads. */
	title: string;
	readOnly: boolean;
	destructive: boolean;
	idempotent: boolean;
	outputSchema: unknown;
```

and in `claude.ts:71-77` emit them. `readOnly` is `risk === 'read'`,
`destructive` is `false` for every tool in this app (nothing deletes),
`idempotent` is true for the reads and for `record_outcome` and
`set_confidence` (both claim a request id).

**7. New file `app/src/lib/routes.ts`, one route registry.** Every URL in
the app and every URL in a tool result comes from here.

```ts
// Every address in the app, in one place, so a page and a tool agree.
export const routes = {
	account: (customerNo: string) => `/accounts/${encodeURIComponent(customerNo)}`,
	commitment: (id: number) => `/commitments/${id}`,
	part: (itemNo: string) => `/parts/${encodeURIComponent(itemNo)}`,
	vendor: (vendorNo: string) => `/vendors/${encodeURIComponent(vendorNo)}`,
	rfqDraft: (id: number) => `/rfq/${id}`,
	rule: (id: number) => `/automations/${id}`,
	conversation: (id: number) => `/ask/${id}`
} as const;
```

Then add a `url` field to every row every read tool returns, built from it.
This also fixes `PickQueue.svelte:74`, the one customer link in the app
that is not encoded.

**8. `app/src/lib/components/accounts/SectionSkeleton.svelte:14`, announce
the load.** The `.sr-only` text is inside the `aria-hidden` subtree, so six
streamed sections on an account page announce nothing.

```svelte
<section class="panel" role="status" aria-label="Loading {title}">
	<div aria-hidden="true">
		... the bars ...
	</div>
</section>
```

**9. `app/src/lib/components/accounts/AccountOrders.svelte:11`, stop
publishing a wrong total.** `openTotal` sums the 50 rows SQL returned and
the header calls it the account's open value. Return the sum and the count
from `app/src/lib/server/accounts/account.ts:444`:

```sql
select ..., count(*) over () as total_lines, sum(l.value) over () as total_value
```

and read those instead of summing in the component.

**10. `app/src/lib/components/accounts/RevenueBars.svelte:38`, fix the zero
line.**

```ts
// The axis is where zero is, not wherever the first bar happens to end.
const baseline = H - below;
```

and scale the positive and negative halves against their own budgets rather
than scaling negatives against `top - 2` while reserving 12px for them.

**11. `app/src/lib/components/CommitmentCard.svelte:66`, put the row action
back in the tab order.** Delete `tabindex="-1"` and name the action with its
record:

```svelte
aria-label="{card.needsOutcome ? 'Answer' : 'Open'}: {card.title}"
```

Same in `app/src/lib/components/accounts/AccountsTable.svelte:137`.

**12. `app/src/lib/components/OutcomeForm.svelte:51`, stop wiping the note
on a refusal.**

```ts
return async ({ update, result }) => {
	// Only clear the form when the write went through; a refusal must leave
	// the note the rep typed where they can fix it.
	await update({ reset: result.type === 'success' });
	submitting = false;
};
```

**13. `app/src/lib/components/exports/UploadPanel.svelte:149`, make the drop
zone real or stop drawing one.** There is no `ondrop` anywhere in the repo,
so a dropped file navigates the browser away. Either add the handlers:

```svelte
<div class="drop"
	ondragover={(e) => { e.preventDefault(); dragging = true; }}
	ondragleave={() => (dragging = false)}
	ondrop={(e) => { e.preventDefault(); dragging = false; if (e.dataTransfer?.files[0]) { fileInput.files = e.dataTransfer.files; fileName = e.dataTransfer.files[0].name; } }}>
```

or remove the dashed border and let it read as a button.

**14. Every `<th>` in the app, add `scope`.** 166 of them across 30 tables,
zero with it today. `scope="col"` in a `thead`, `scope="row"` on a row's
first cell where one identifies the row.

**15. `docs/handoff.md`, rename the jargon.** "RFQ draft" appears in the nav
label, three page titles, the breadcrumbs and about thirty strings. It is
already listed as planned item 6; this audit agrees with the owner.
"Quote request" for the object, "Quote requests" for the section.

**16. `app/src/lib/server/assistant/tools.ts:332-344` and the migrations,
close the two read gaps.** Grant `nl_readonly` select on
`nl.export_snapshots` (an agent can `decide_export` on a snapshot it cannot
read) and add `nl.available_to_promise` to the six-function allowlist.

**17. Take real content off `--text-faint`.** The token now passes 4.5:1 on
its own, but 89 measured failures in light and 86 in dark included cases
where `.faint` was stacked with a second dimming and landed at **2.66:1**.
These four are content, not decoration, and should be `.muted`:

- `app/src/lib/components/SearchBox.svelte:108`, the `kbd` showing the
  `/` shortcut. It is on all 21 signed-in views.
- `app/src/lib/components/warehouse/RecentMoves.svelte`, the
  `span.faint.desc` item description a picker reads.
- `app/src/lib/components/warehouse/PartLedgerPanel.svelte`, the
  `td.mono.nowrap` sales order number in the ledger.
- `app/src/routes/rfq/+page.svelte:47`, the `p.faint.small` sentence
  explaining why live mode is off.

The rule of thumb to apply while doing item 4: `--text-faint` is for a
separator, a placeholder or a decorative glyph. Anything a person needs to
read is `--text-muted` or `--text`.

**18. The three grids and one table that still push the page wide.**
`min-width: 0` on the page's children stops the container growing, but
these four will still force a horizontal scroller inside their panel at
375px, and the first three are the `auto-fit` pattern this project's own
rules flag for Safari iOS:

- `commitments/[id]/+page.svelte:467`
  `repeat(auto-fit, minmax(260px, 1fr))`
- `parts/[item]/+page.svelte:493` `repeat(auto-fit, minmax(340px, 1fr))`
- `Board.svelte:194` `repeat(6, minmax(232px, 1fr))` inside a snap scroller
- `TestResults.svelte:108` `table { min-width: 640px }`

Replace the first three with `display: flex; flex-wrap: wrap` and a
`flex: 1 1 <basis>` on the children, which is what `rfq/[id]:348` already
does and what the comment there explains.

**19. `app/src/routes/warehouse/+page.svelte:33-37` and four more places,
stop explaining the database to the person using it.** The worst is
`PartLedgerPanel.svelte:88`, which shows a warehouse picker the string
`nl.warehouse_drift()`. Replace with "Operations has been told and is
reconciling it" and keep the function name in a code comment. The others:
"Tokens: 812 in · 140 out · 0 cached" (`rfq/[id]:48`), the raw millisecond
figure (`Lookup.svelte:41`), the model id (`rfq/+page.svelte:47`), and
"Every part in the item master" (`parts/+page.svelte:27`).

---

## What I measured, what I inferred, and what I could not check

**Measured in a real browser**, headless Chromium 1243 driven by Playwright
1.63, against the dev server on PGlite with today pinned to 2026-09-17:
rendered font sizes and their counts; contrast ratios computed against the
real composited background per text node, in light and in dark; accessible
names on every interactive element; element rectangles at 375px; field font
sizes; landmark, heading, `th`, `th[scope]`, `aria-live`, `aria-busy`,
`role=tab`, `role=dialog` and `data-*` counts; page titles; horizontal
overflow and the widest element; tab order for the first 26 stops on three
pages with focus-ring visibility per stop; and console and page errors.
23 views, three contexts each, plus a signed-out pass.

**Inferred from the source only**, and marked where it matters: Safari iOS
behaviour (the `repeat(auto-fit, minmax())` grids, `backdrop-filter` on a
sticky element, and whether iOS actually zooms at 13px). I have no Safari
here. The project's own rules already flag the grid pattern, which is why I
treat it as a finding rather than a guess.

**What I could not check:**

- **The name scan.** `CLAUDE.md` requires
  `node tools/scan.mjs . <word list>` to print `0 hit(s)` before every
  commit, and says the word list lives outside the repository and to ask
  Owen for its path. I do not have it, so I could not run the gate. I
  introduced no company name, no person's name and no customer name: the
  only proper nouns in anything I wrote are "Northline", "Northline Exhaust
  Co.", "Postgres", "SvelteKit", "Svelte", "Chromium", "Playwright" and
  "Safari". Owen should run the scan before this branch goes anywhere.
- **The two feature branches moved while I read them.** `mcp-server` and
  `agent-workspace` both gained substantial work mid-audit, from sibling
  worktrees. Pass 2 describes `mcp-server` at `87a0cca` and
  `agent-workspace` at `04a8fdd`. Check the tips.
- **`procurement-desk`** was not read. Out of scope.
- **Whether the twelve new components actually look right in place.**
  Nothing imports them, because every route file belongs to another agent.
  They compile (`npm run check` is 0 errors) and their CSS comes from the
  shared tokens, and they have not been seen on a screen.
- **Whether raising `h1` from 17.55px to 21px and `h2` from 13px to 17px
  reflows any page badly.** Measured no horizontal overflow at 375px after
  the change, and I did not compare every page's vertical layout before
  and after. Several route files override these sizes locally, so there
  will be a transitional period where a page mixes the old and the new;
  item 1 in the ranked list is what ends it.
- **Performance.** No bundle size, no Lighthouse, no query timing. The
  fonts are self-hosted, which was the comparison app's worst performance
  finding, and beyond that I did not look.
- **The full world.** Every measurement is against the `small` world, so
  the row counts on screen are small. The caps and the missing pagination
  are read from the SQL, not from a page that actually rendered 3,000
  rows.
