import { defineConfig } from 'vitest/config';
import adapter from '@sveltejs/adapter-vercel';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) => filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter(),
			typescript: {
				// Type-check the helper scripts in scripts/ along with the app.
				config: (config) => {
					config.include.push('../scripts/**/*.ts');
				}
			}
		})
	],
	// The icon package ships .svelte files, so the server must compile it
	// instead of handing it to Node.
	ssr: { noExternal: ['@lucide/svelte'] },
	// 5173 and 5174 belong to other projects on the development machine.
	server: { port: 5180, strictPort: true },
	preview: { port: 5181, strictPort: true },
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}'],
					/*
					  Each database test file starts its own PGlite (Postgres in
					  WebAssembly), applies every migration and builds a small
					  world. That was a few seconds when there were a dozen
					  migrations. There are more than forty now, plus fifteen seed
					  generators, so one database takes on the order of two minutes
					  on a loaded machine and the whole suite is the dominant cost
					  of working here.

					  These numbers are generous on purpose: a timeout here means
					  the machine was busy, never that the code is wrong, and a
					  suite that fails for being slow teaches people to ignore red.
					  The real fix is to build the database once and share it
					  between files, which is a change worth making deliberately
					  and not on a deadline. See docs/handoff.md.
					*/
					testTimeout: 180_000,
					hookTimeout: 360_000
				}
			}
		]
	}
});
