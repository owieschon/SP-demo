// The resolve hook itself. Registered by lib-alias.mjs; Node runs it on its
// own loader thread, which is why it is a file of its own.
const lib = new URL('../src/lib/', import.meta.url).href;
const hasExtension = /\.[a-z]+$/;

export async function resolve(specifier, context, next) {
	let spec = specifier;
	// SvelteKit's alias.
	if (spec === '$lib' || spec.startsWith('$lib/')) {
		spec = new URL(spec === '$lib' ? 'index' : spec.slice('$lib/'.length), lib).href;
	}
	try {
		return await next(spec, context);
	} catch (error) {
		// Vite lets an import leave the extension off and Node does not, so a
		// specifier that resolved to nothing gets one more try with .ts.
		if (!hasExtension.test(spec)) return next(`${spec}.ts`, context);
		throw error;
	}
}
