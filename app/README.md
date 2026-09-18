# Northline application

This directory contains the SvelteKit application. Use the repository
[quickstart](../README.md#run-it-locally) for the credential-free local setup and
the [focused tour](../README.md#take-the-focused-tour) for the shortest review path.

Run application commands from this directory:

```bash
npm ci
npm run dev        # http://localhost:5180
npm run check      # Svelte and TypeScript checks
npm test           # Vitest against in-memory PGlite
npm run build      # production build with the Vercel adapter
npm run eval:rfq   # rules-only RFQ regression evaluation
```

With no `.env`, development uses a persistent PGlite database in `.pglite/` and
needs no external services. `DATABASE_URL` switches the app to hosted Postgres;
leave it unset for a local review. See the [database guide](../db/README.md) for the
schema and world-building commands.
