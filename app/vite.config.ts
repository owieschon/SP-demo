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
					// Each database test file starts its own PGlite (Postgres in
					// WebAssembly) and builds a small world, which takes a few seconds.
					testTimeout: 60_000,
					hookTimeout: 180_000
				}
			}
		]
	}
});
