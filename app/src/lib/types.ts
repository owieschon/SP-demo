// Types shared by the server and the pages.

import type { Preset } from './roles/types.ts';

/*
  A role is now the name of a preset: a starting set of scope, authority and
  disclosure (migration 0027, $lib/roles/types). It is a label and nothing
  resolves a permission from it, so this type is only used for what to call
  somebody on screen.
*/
export type Role = Preset;

/** The signed-in person, as the pages see them. */
export interface SessionUser {
	id: number;
	fullName: string;
	title: string;
	role: Role;
	/** One line saying what they answer for. Empty until somebody sets it. */
	responsibility: string;
}

/** Derived in SQL (nl.commitment_progress), never stored. */
export type CommitmentStatus = 'promised' | 'quoted' | 'delivering' | 'kept' | 'pushed' | 'broken';

export const STATUS_ORDER: CommitmentStatus[] = [
	'promised',
	'quoted',
	'delivering',
	'kept',
	'pushed',
	'broken'
];

export const STATUS_LABEL: Record<CommitmentStatus, string> = {
	promised: 'Promised',
	quoted: 'Quoted',
	delivering: 'Delivering',
	kept: 'Kept',
	pushed: 'Pushed',
	broken: 'Broken'
};

/** The three answers to "the window closed short: what happened?" */
export type Outcome = 'pushed' | 'kept' | 'broken';

export const OUTCOME_CHOICES: { value: Outcome; label: string; hint: string }[] = [
	{ value: 'pushed', label: 'Still coming', hint: 'The business moved out of this window.' },
	{ value: 'kept', label: 'Close enough', hint: 'Count it as kept.' },
	{ value: 'broken', label: "They didn't buy", hint: 'Record it as broken.' }
];

/** How many settled cards a board column shows; the rest are only counted. */
export const SETTLED_CARD_LIMIT = 12;

export type SettledStatus = 'kept' | 'pushed' | 'broken';

/** The board: its cards, plus the full size of each settled column. */
export interface BoardData {
	cards: BoardCard[];
	settled: Record<SettledStatus, { count: number; committed: number }>;
}

export interface BoardCard {
	id: number;
	title: string;
	customerNo: string;
	customerName: string;
	ownerId: number;
	ownerName: string;
	buyerName: string | null;
	committedValue: number;
	delivered: number;
	deliveredRatio: number;
	expectedValue: number;
	confidence: number;
	startsOn: string;
	endsOn: string;
	status: CommitmentStatus;
	needsOutcome: boolean;
	daysSinceClose: number | null;
	windowElapsedRatio: number;
	outcomeSource: 'person' | 'nightly' | null;
	updatedAt: string;
}
