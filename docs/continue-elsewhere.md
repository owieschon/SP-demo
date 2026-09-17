# Picking this up on another machine

Everything needed is in the repository, in Vercel's settings, or in Supabase.
Nothing important lives only on one laptop.

## 1. Get the code

```sh
git clone https://github.com/<your-account>/sp-demo.git
cd sp-demo/app
npm ci
```

The repository is private, so the clone asks for a GitHub sign-in. On a new
machine the simplest way is a personal access token: GitHub, Settings,
Developer settings, Personal access tokens, fine-grained, read and write on
this one repository, then paste it as the password when git asks.

## 2. Run it with no database at all

```sh
npm run dev      # http://localhost:5180
```

With no `app/.env`, the app builds its own Postgres (PGlite) from `db/` on
first start, about a minute, and runs the mid-sized world. Tests need nothing
either:

```sh
npm run check
npm test
```

## 3. Run it against the live database (optional)

Create `app/.env` from `app/.env.example` and fill in:

| Variable | Where to get it |
|---|---|
| `DATABASE_URL` | Vercel, project sp-demo, Settings, Environment Variables. Copy the value. It is the shared pooler host on port 6543. |
| `SESSION_SECRET` | The same page, or make a new random one (it only signs cookies). |
| `AGENTMAIL_API_KEY` | The AgentMail console, or Vercel once it is set there. |
| `MAIL_INBOX_ORDERS`, `MAIL_INBOX_PROCUREMENT`, `MAIL_ALLOWLIST` | `app/.env.example` shows the shape; the addresses are the two agent desks, and the allowed list is the owner's own addresses. |

Then, from `app/`:

```sh
node --env-file=.env scripts/db-remote.ts status     # what is applied
node --env-file=.env scripts/db-remote.ts migrate    # apply what is pending
node --env-file=.env scripts/db-remote.ts seed       # load the world generator
node --env-file=.env scripts/db-remote.ts rebuild    # rebuild the full world (about 2 minutes)
```

Warning, learned the hard way: `seed` loads every file in `db/seed.d/`,
including any half-finished one in your working tree, and those functions then
stay in the database and run on the next build. If a build fails with "function
nl.something does not exist", drop the stale one:

```sql
select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'nl_seed' and p.proname like 'extra%';
drop function if exists nl_seed.extra_NN_name();
```

Seeding from the committed tree only avoids it:

```sh
git archive HEAD db | tar -x -C /tmp/nl-head
NL_DB_DIR=/tmp/nl-head/db node --env-file=.env scripts/db-remote.ts seed
```

## 4. Where things stand

`docs/handoff.md` is the status: what is finished on `main`, what is being
built and by whom, and what is planned and free to pick up. Read it before
writing anything.

Branch `wip-local-snapshot` holds work in progress taken off the owner's PC so
it would not be stranded: the late-order forecast (migration 0016), document
parsing and PDF quotes (0020), and the order desk mail agent (0021). It is not
reviewed and not tested as a whole. Take the finished parts out of it rather
than merging the branch.

## 5. Deploys and secrets

- Pushing to `main` deploys to Vercel automatically. There is no staging.
- Vercel needs `DATABASE_URL` and `SESSION_SECRET` (set), and `CRON_SECRET`
  and the mail variables for the scheduled runs and the desks.
- Secrets are the owner's: never commit one, and `app/.env` stays gitignored.

## 6. The name scan before every commit

The private word list lives outside the repository, so a machine that does not
have it cannot run the scan. Either copy the list to the new machine from
wherever the owner keeps it and run

```sh
node tools/scan.mjs . <path to the word list>
```

or leave commits on a branch and let a machine that has the list scan before
anything reaches `main`. Scan the git index rather than the working tree, since
`app/.env` holds the owner's own domains and would trip it:

```sh
git checkout-index -a --prefix=/tmp/scan/
node tools/scan.mjs /tmp/scan <path to the word list>
```
