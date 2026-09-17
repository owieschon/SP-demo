// Types shared by the server and the pages.

export type Role = 'account_manager' | 'operations' | 'admin';

/** The signed-in person, as the pages see them. */
export interface SessionUser {
	id: number;
	fullName: string;
	title: string;
	role: Role;
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
