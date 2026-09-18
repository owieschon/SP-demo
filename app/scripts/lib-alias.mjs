// Teach plain Node about SvelteKit's `$lib` alias.
//
// Vite resolves `$lib/...` to `src/lib/...` when the app runs or when vitest
// runs a test. A script started with plain `node` has no Vite, and the agent
// evals reach code that imports `$lib/desk/types`, `$lib/format` and
// `$lib/automation/catalog`, so it has to be told.
//
// Used by `npm run eval:agents`:
//
//   node --import ./scripts/lib-alias.mjs scripts/eval-agents.ts
//
// The hook lives in lib-alias-hooks.mjs, because Node runs resolve hooks on a
// loader thread of their own.
import { register } from 'node:module';

register(new URL('./lib-alias-hooks.mjs', import.meta.url));
