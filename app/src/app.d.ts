// See https://svelte.dev/docs/kit/types#app.d.ts
import type { SessionUser } from '$lib/types';

declare global {
	namespace App {
		interface Locals {
			/** Set by hooks.server.ts from the session cookie; null when nobody is signed in. */
			user: SessionUser | null;
		}
		// interface Error {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
