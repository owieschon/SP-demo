# Northline app

SvelteKit 2, Svelte 5 (runes), TypeScript, Vitest, deployed on Vercel.

```sh
npm install
npm run dev        # http://localhost:5180
```

With no `.env`, the app builds a local Postgres (PGlite) in `.pglite/` from
`../db` on first start; that takes a minute or two. With `DATABASE_URL` set
(see `.env.example`), it uses Supabase instead.

```sh
npm run check      # svelte-check and TypeScript
npm test           # Vitest, database tests on PGlite
npm run build      # production build (Vercel adapter)
```

Helper scripts (Node 24 runs TypeScript directly):

```sh
node scripts/world.ts small           # build a world in memory and print the board
node scripts/fingerprint.ts           # hashes to compare with Supabase
```
