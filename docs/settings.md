# Settings and the admin console

`/settings` is where the API keys, the mail desks, the scheduled run and the
health of a deployment live, so a key can be pasted into the app instead of
edited into a file or a hosting dashboard.

Files: `db/migrations/0025_settings.sql`, `app/src/lib/server/settings/**`,
`app/src/lib/components/settings/**`, `app/src/routes/settings/`.

## The problem this page had to solve first

This app is a public demo and signing in needs no password: the sign-in page
lists everyone and you pick one, the admin included. So "this person's role is
admin" protects nothing, and a page that holds an API key cannot be guarded by
a role.

What guards it is **first-run ownership**. The first person to open `/settings`
claims the instance by choosing a passcode of at least twelve characters. From
then on every change needs that passcode, and the page will not let anyone set
a new one without it.

**Say this plainly: the passcode is the only thing between a visitor and the
keys.** This is a portfolio demo, not a multi-tenant product. There is one
passcode for the whole instance, not one per person. There is no email
confirmation, no recovery, no second factor, and no way to prove that the
person who claimed the instance is its owner: whoever gets there first claims
it. The rest of this file says exactly how far the guarantees go.

## What is stored

Schema `nl_config`, not `nl`, and that matters: `nl.reset()` truncates every
table in schemas `nl` and `nl_seed`, and the nightly job calls it, so a key or
a passcode kept in `nl` would be wiped every night. Nothing in `nl_config` has
a foreign key to `nl.users` either, because `truncate nl.users cascade` would
take the referencing rows with it. `updated_by` is a plain integer and the
name is looked up when the page renders.

| Table | What is in it |
|---|---|
| `nl_config.settings` | one row per setting: the value (text) or the secret (encrypted, base64), whether it is secret, the last four characters of a secret, who changed it and when |
| `nl_config.admin_lock` | one row, ever: the passcode's scrypt hash, its salt, who claimed the instance and when |
| `nl_config.admin_attempts` | every attempt at the passcode, right or wrong, which is the rate limit's memory |

The settings that exist are a fixed list, checked by a constraint that calls
`nl.setting_keys()`. A key that is not in that list cannot be stored.

| Key | Secret | Falls back to | What it changes |
|---|---|---|---|
| `anthropic_api_key` | yes | `ANTHROPIC_API_KEY` | with a key set, Ask uses the real model |
| `anthropic_model` | no | `ANTHROPIC_MODEL` | which model answers |
| `live_ai_passphrase` | yes | `LIVE_AI_PASSPHRASE` | optional; set one and it has to be typed before the real model answers |
| `assistant_daily_per_user` | no | `ASSISTANT_DAILY_PER_USER` | model calls per person per day |
| `assistant_daily_total` | no | `ASSISTANT_DAILY_TOTAL` | model calls for the whole server per day |
| `agentmail_api_key` | yes | `AGENTMAIL_API_KEY` | the key the mail desks send with |
| `mail_inbox_orders` | no | `MAIL_INBOX_ORDERS` | where order desk mail arrives |
| `mail_inbox_procurement` | no | `MAIL_INBOX_PROCUREMENT` | where procurement mail arrives |
| `mail_allowlist` | no | `MAIL_ALLOWLIST` | the only addresses the app may send to |
| `cron_secret` | yes | `CRON_SECRET` | the shared secret the scheduled run sends |

Anything stored wins over the environment variable. Clearing a setting gives
the environment variable back, which is why "Clear what is saved here" exists
next to every stored value. A stored value that is blank counts as not set.

## How a secret is encrypted

The app encrypts it before it goes anywhere near Postgres:
`AES-256-GCM`, with a 32 byte key derived by `scrypt` from the server's session
secret under the fixed label `northline.settings.v1`, a fresh 12 byte
initialization vector per save, stored as `v1.<base64 of iv, tag and
ciphertext>` (`app/src/lib/server/settings/crypto.ts`).

Why in the app and not with `pgcrypto`'s `pgp_sym_encrypt`:

- the plaintext and the encryption key never travel to the database at all, so
  neither can land in a query log or a statement error;
- GCM authenticates, so a stored value edited by hand fails to decrypt instead
  of returning nonsense;
- `pgcrypto` is available on Supabase but **not** in PGlite unless the
  extension bundle is registered when the database is created
  (`import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'` and
  `extensions: { pgcrypto }` in `PGlite.create`). Doing the encryption in the
  app means the tests exercise exactly the code that runs on Supabase, rather
  than a second code path that only exists locally.

The passcode is hashed the same way round: `scrypt` with a random 24 byte salt,
stored as 64 hex characters. The comparison happens in the database, in
`nl.constant_time_equal`, which walks the whole digest instead of stopping at
the first difference. The passcode itself is never a parameter to any SQL
function, which is also why the database cannot check how long it is: the
minimum length is checked in the app (`MIN_PASSCODE_LENGTH`).

### When the session secret is rotated

**Rotating `SESSION_SECRET` makes every stored secret unreadable, and each one
has to be pasted again.** The ciphertext is still there and still safe; the key
that opens it is gone. Nothing breaks: a setting that cannot be read is
reported as "Stored, but this server cannot read it", the Health section says
so in red with what to do, and the app falls back to the environment variable
in the meantime.

Locally, `SESSION_SECRET` is optional: without it the server makes up a random
one at startup, so a key saved in Settings stops being readable at the next
restart. Health says that too. On a deployment the server refuses to start
without one.

## Who may change what

1. Nothing at all until the instance is claimed. `nl.set_setting` and
   `nl.clear_setting` raise `NL403` while `nl_config.admin_lock` is empty.
2. Claiming is a one-time write. `nl.claim_instance` refuses a second claim
   with `NL409`, so a visitor cannot take over a claimed instance.
3. A correct passcode sets a signed, httpOnly cookie, `nl_settings_admin`, on
   path `/settings`, for twelve hours. It is the same shape as the one Ask
   Northline uses for live mode: `<user id>.<expires at>.<signature>`, signed
   with the session secret under the prefix `settings.`, and compared in
   constant time. The user id in it cannot be changed, the expiry cannot be
   stretched, and the signature never matches another cookie in this app.
4. Wrong answers are counted per person in the database: five inside fifteen
   minutes and that person waits, and the page says for how long. A locked
   attempt is not counted, so the lock ends rather than extending itself.
5. The passcode can be changed only by someone who can type the old one. The
   old hash is compared in the database, not trusted from the app.
6. Every change writes a row to `nl.audit_log`, including a wrong attempt and
   a locked one. A secret is never in that row: only whether it was secret and
   its last four characters.

### What this model does not do

- **One passcode, not one per person.** Anyone who knows it is an admin here.
- **A change of passcode does not sign anyone out.** Cookies already issued
  stay valid until their twelve hours run out. The page says so.
- **The cookie is the authority for a settings write, not the passcode.** The
  functions check that the instance is claimed and that an active person is
  signed in; the app checks the cookie before it calls them. Anyone who could
  run SQL as the app's own role could therefore write a setting without the
  passcode, but anyone in that position owns the server already.
- **Health is visible to anyone signed in.** It holds no secret, on purpose:
  whether a key is set, the row counts, the drift checks, the last nightly run
  and the commit. Someone without the passcode sees that and nothing they can
  change.
- **The rate limit counts per person.** Somebody who signs in as a different
  person from the picker gets a fresh five tries. Guessing is still slow (an
  scrypt hash per try, a deliberate pause, and every attempt on the record),
  but the limit is not a wall.
- **There is no recovery.** Forgetting the passcode means clearing
  `nl_config.admin_lock` by hand with database access.

## What no role can read

`nl_config`'s tables are granted to nobody. `nl_app`, the role every request
runs as, can read exactly one thing: the view `nl.settings`, which has no
secret column in it at all. The write functions and `nl.settings_with_secrets()`
are `security definer`, so they reach the rows on the caller's behalf, and only
`nl_app` may execute them.

`nl_readonly`, the role the assistant's read-only SQL tool runs as, is granted
**nothing here**: not the tables, not the view, not one function. A query
against any of them comes back as "permission denied", which is a test, not a
claim (see below). Row-level security is enabled on all three tables with no
policy, so even a grant added by mistake later would still read nothing.

The view `nl.settings` deliberately does not set `security_invoker = true`,
unlike every other view in this project. That is what lets it read the base
table for a caller who cannot. It is safe because the secret is not in it.

## Health

The Health section runs on the server, streams in after the page, and contains
no secret. It reports:

- whether `SESSION_SECRET` is set, and what happens if it is not;
- whether the instance has been claimed;
- how many stored secrets there are and whether this server can read them;
- what Ask Northline will do right now;
- the three drift checks, through `nl.diagnostic_drift()`:
  `nl.delivery_drift()` (stored delivered figures against a fresh count),
  `nl.warehouse_drift()` when the warehouse tables exist, and ledger lines
  whose stored cost disagrees with the cost timeline for the day they were
  posted, over the last ninety days so the check stays quick on the full world;
- the last nightly run: pg_cron's `cron.job_run_details` where pg_cron exists,
  otherwise the newest audit row the nightly job left;
- the size of the database and the row counts of the main tables;
- which environment variables are set, as set or not set, never as values,
  except for a few that are not secrets (the model name, `ASSISTANT_MOCK`, the
  commit);
- the commit this deployment was built from, `VERCEL_GIT_COMMIT_SHA`, or
  "local".

Each line is green, red or a plain figure, and a red one carries the sentence
that says what to do.

### Why there is no "rebuild the world now" button

A rebuild empties every table in the world and fills it again. It takes about a
minute and a half and holds its locks until it commits, so every page waits on
it. This app has no job queue to run that in, and a serverless request is cut
off long before it would finish, so a button would leave a half-built world
behind and no way to tell. On Supabase the pg_cron job in
`db/migrations/0012_nightly.supabase.sql` does it at 00:10 Chicago time; by
hand it is `node --env-file=.env scripts/db-remote.ts rebuild` from `app/`.
Locally the world rebuilds itself when the date changes. The Jobs section says
this on the page, and Health shows when the last run was.

## The tests that prove each guarantee

`app/src/lib/server/settings/admin.test.ts` (12 tests, no database) and
`app/src/lib/server/settings/settings.test.ts` (33 tests, PGlite, today pinned
to 2026-09-17).

| Claim | Test |
|---|---|
| The instance can only be claimed once | `claiming the instance > cannot be claimed a second time, by anyone` |
| A passcode shorter than twelve characters is refused | `claiming the instance > refuses a passcode that is too short` |
| The passcode itself is never stored | `claiming the instance > never stores the passcode` |
| A wrong passcode is refused and recorded | `the passcode > is refused when it is wrong, with the tries left, and leaves a record` |
| Five wrong answers lock that person, and only that person | `the passcode > locks that person out after five wrong answers in fifteen minutes` |
| A correct one unlocks | `the passcode > unlocks when it is right, and records the attempt` |
| A retried attempt is not counted twice | `the passcode > answers the same request id once` |
| The cookie cannot be forged, reused by another person or stretched | `the passcode cookie > ...` (four tests) |
| A secret never leaves the server: the page gets `set`, `last4` and `updated_at` | `what the browser is allowed to see > gets whether a secret is set, its last four characters and when, and nothing else` |
| A secret is stored encrypted and read back only with the right session secret | `storing a setting > stores a secret encrypted, never as itself`, `crypto > cannot be read under a different session secret` |
| A rotated session secret is reported, not hidden | `storing a setting > reports a stored secret as unreadable when the session secret has changed` |
| A stored key overrides the environment variable, and a cleared one falls back | `storing a setting > takes over from the environment variable, and gives it back when cleared` |
| The assistant's SQL tool cannot read the settings | `the assistant's read-only SQL tool > cannot read the settings, whichever way it asks` (six ways) |
| Every write leaves an audit row, and a secret is not in it | `storing a setting > saves a value, leaves an audit row`, `> leaves an audit row when a setting is cleared, without the secret in it` |
| The diagnostics never include a secret | `the health checks > report the world without any secret in them` |
| A red check says what to do | `the health checks > say what to do when something is red` |
| Nothing can be stored before the instance is claimed | `before anyone has claimed the instance > refuses to store a setting at all` |
| A stale page cannot overwrite a newer value | `storing a setting > refuses a save from a page that was loaded before somebody else saved` |
| Only someone who knows the old passcode can change it | `changing the passcode > refuses somebody who cannot type the old one` |
| The app's list of settings and the database's are the same | `before anyone has claimed the instance > has the same list of settings as the app` |
