// Reading the role model: one principal's scope, authority and disclosure,
// and the list of everybody for /people.
//
// Everything here is a read. The writes are in writes.ts, and they all go
// through a database function so the audit row and the request id cannot be
// forgotten.
import type { Db, Tx } from '../db/types.ts';
import { columnSource, policyEnginePresent, type ColumnSource } from './dictionary.ts';
import {
	AUTHORITIES,
	SCOPE_DIMENSIONS,
	type Authority,
	type AuthorityAhead,
	type AuthorityHolding,
	type Disclosure,
	type PrincipalPolicy,
	type Preset,
	type ScopeDimension,
	type ScopeSlice
} from '$lib/roles/types';

/** One row of nl.people_policy, before it is tidied up. */
interface PolicyRow {
	id: number;
	email: string;
	full_name: string;
	title: string;
	role: string;
	kind: string;
	responsibility: string;
	active: boolean;
	disclosure: string;
	scope: Record<string, { all: boolean; count: number | null }>;
	authority: Record<
		string,
		{ limit: string | number | null; unlimited: boolean; starts_on: string; ends_on: string | null }
	>;
	authority_ahead: { authority: string; limit: string | number | null; starts_on: string }[];
}

const POLICY_COLUMNS = `
	id, email, full_name, title, role, kind, responsibility, active,
	disclosure, scope, authority, authority_ahead`;

function asPreset(value: string): Preset {
	// The database's check constraint already refused anything else, so this
	// is a cast and not a decision.
	return value as Preset;
}

function asNumber(value: string | number | null): number | null {
	if (value === null) return null;
	const n = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(n) ? n : null;
}

/**
 * The named values in one dimension. nl.people_policy carries the counts, not
 * the values, because an account manager's slice is hundreds of customer
 * numbers and no screen shows them all at once. The /people page asks for one
 * dimension's values when somebody opens it.
 */
export async function scopeValues(
	db: Db,
	userId: number,
	dimension: ScopeDimension
): Promise<string[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.sql<{ value: string }>`
			select value from nl.user_scope
			where user_id = ${userId} and dimension = ${dimension} and value is not null
			order by value`
	);
	return rows.map((r) => r.value);
}

function tidy(row: PolicyRow): PrincipalPolicy {
	const scope: ScopeSlice[] = SCOPE_DIMENSIONS.filter((d) => row.scope[d]).map((dimension) => ({
		dimension,
		all: row.scope[dimension].all,
		// The counts are what the list needs; the values themselves are asked
		// for one dimension at a time (scopeValues above).
		values: []
	}));

	const authority: AuthorityHolding[] = AUTHORITIES.filter((a) => row.authority[a]).map(
		(name: Authority) => ({
			authority: name,
			limit: asNumber(row.authority[name].limit),
			startsOn: row.authority[name].starts_on,
			endsOn: row.authority[name].ends_on,
			note: ''
		})
	);

	const authorityAhead: AuthorityAhead[] = row.authority_ahead.map((a) => ({
		authority: a.authority as Authority,
		limit: asNumber(a.limit),
		startsOn: a.starts_on
	}));

	return {
		id: row.id,
		email: row.email,
		fullName: row.full_name,
		title: row.title,
		preset: asPreset(row.role),
		kind: row.kind === 'agent' ? 'agent' : 'person',
		responsibility: row.responsibility,
		active: row.active,
		disclosure: row.disclosure as Disclosure,
		scope,
		authority,
		authorityAhead
	};
}

/** How many named values each principal holds per dimension, for the list. */
export interface ScopeCounts {
	[dimension: string]: { all: boolean; count: number | null };
}

/** The signed-in principal's own policy. Every request needs it for the rail. */
export async function policyFor(db: Db, userId: number): Promise<PrincipalPolicy> {
	const [row] = await db.asUser(userId, (tx) =>
		tx.query<PolicyRow>(`select ${POLICY_COLUMNS} from nl.people_policy where id = $1`, [userId])
	);
	if (!row) {
		throw new Error(`No principal with id ${userId}.`);
	}
	return tidy(row);
}

/** The same thing inside a transaction somebody else opened. */
export async function policyIn(tx: Tx, userId: number): Promise<PrincipalPolicy> {
	const [row] = await tx.query<PolicyRow>(
		`select ${POLICY_COLUMNS} from nl.people_policy where id = $1`,
		[userId]
	);
	if (!row) throw new Error(`No principal with id ${userId}.`);
	return tidy(row);
}

export interface PeopleList {
	people: PrincipalPolicy[];
	agents: PrincipalPolicy[];
	/** Raw scope counts per principal id, so the list can say "41 accounts". */
	counts: Record<number, ScopeCounts>;
	/** May the signed-in person change any of this? */
	mayChange: boolean;
	/** Only an admin may hand out change_policy itself. */
	isAdmin: boolean;
	/** Where the column declarations came from (see dictionary.ts). */
	columnSource: ColumnSource;
	/** Whether the policy engine is answering the limits (see dictionary.ts). */
	policyEngine: boolean;
}

/** Everybody and every agent, for /people. */
export async function listPeople(db: Db, userId: number): Promise<PeopleList> {
	const { rows, mayChange, isAdmin } = await db.asUser(userId, async (tx) => {
		const rows = await tx.query<PolicyRow>(
			`select ${POLICY_COLUMNS} from nl.people_policy
			 order by kind, active desc, full_name`
		);
		const [flags] = await tx.sql<{ may_change: boolean; is_admin: boolean }>`
			select nl.may_change_roles() as may_change, nl.is_admin() as is_admin`;
		return { rows, mayChange: flags.may_change, isAdmin: flags.is_admin };
	});

	const all = rows.map(tidy);
	const counts: Record<number, ScopeCounts> = {};
	for (const row of rows) counts[row.id] = row.scope ?? {};

	return {
		people: all.filter((p) => p.kind === 'person'),
		agents: all.filter((p) => p.kind === 'agent'),
		counts,
		mayChange,
		isAdmin,
		columnSource: await columnSource(db),
		policyEngine: await policyEnginePresent(db)
	};
}
