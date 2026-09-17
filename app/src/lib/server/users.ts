// People who use the app.
import type { Db } from './db/types.ts';
import type { Role, SessionUser } from '$lib/types';

interface UserRow {
	id: number;
	full_name: string;
	title: string;
	role: Role;
	active: boolean;
}

export interface PickerUser extends SessionUser {
	active: boolean;
}

/** Everyone, for the "sign in as" picker. Nobody is signed in yet. */
export async function listUsers(db: Db): Promise<PickerUser[]> {
	const rows = await db.asVisitor((tx) =>
		tx.sql<UserRow>`select id, full_name, title, role, active from nl.users order by active desc, id`
	);
	return rows.map((r) => ({ id: r.id, fullName: r.full_name, title: r.title, role: r.role, active: r.active }));
}

/** The user behind a session cookie, if they exist and are still active. */
export async function findActiveUser(db: Db, id: number): Promise<SessionUser | null> {
	const [row] = await db.asVisitor((tx) =>
		tx.sql<UserRow>`select id, full_name, title, role, active from nl.users where id = ${id} and active`
	);
	return row ? { id: row.id, fullName: row.full_name, title: row.title, role: row.role } : null;
}

/** Account managers see their own book first; operations and admins see everyone's. */
export function seesEveryoneByDefault(user: SessionUser): boolean {
	return user.role !== 'account_manager';
}
