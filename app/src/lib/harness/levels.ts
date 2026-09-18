// The autonomy ladder's vocabulary, in one place both sides can import.
//
// These four names and their sentences were in $lib/server/harness/types.ts,
// which a page component may only `import type` from: a value imported out of
// $lib/server would pull server code into the browser bundle, and SvelteKit
// refuses it. Rather than write the four labels out a second time in a
// component, they live here and types.ts re-exports them, so there is still
// one definition of what "auto, with undo" means.
export type Level = 'shadow' | 'suggest' | 'auto_review' | 'auto';

export const LEVELS: Level[] = ['shadow', 'suggest', 'auto_review', 'auto'];

export const LEVEL_LABEL: Record<Level, string> = {
	shadow: 'Shadow',
	suggest: 'Suggest',
	auto_review: 'Auto, with undo',
	auto: 'Auto, sampled'
};

export const LEVEL_MEANING: Record<Level, string> = {
	shadow: 'It drafts and nobody is asked to look. The draft is kept for the record.',
	suggest: 'It drafts and a person decides every one.',
	auto_review: 'It acts, and a person can undo it inside a window.',
	auto: 'It acts. A sampled share is reviewed afterwards, and a bad sample drops it back.'
};

/**
 * Where each level sits on the ladder, 1 to 4. The autonomy GRANT in
 * nl.authority_grants counts the same ladder from 0, because a ceiling there
 * is a number like every other ceiling, so the grant for a level is its order
 * minus one. $lib/server/harness/promotion.ts is the only place that converts.
 */
export const LEVEL_ORDER: Record<Level, number> = {
	shadow: 1,
	suggest: 2,
	auto_review: 3,
	auto: 4
};
