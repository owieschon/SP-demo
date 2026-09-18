// People who use the app.
//
// nl.users holds agents too since migration 0027, so both queries here say
// kind = 'person'. An agent has scope, authority and disclosure like anybody
// else and no way in: no password, no session, and never in the picker.
import type { Db } from './db/types.ts';
import type { Role, SessionUser } from '$lib/types';

interface UserRow {
	id: number;
	full_name: string;
	title: string;
	role: Role;
	responsibility: string;
	active: boolean;
}

export interface PickerUser extends SessionUser {
	active: boolean;
}

const PICKER_COLUMNS = 'id, full_name, title, role, responsibility, active';

function toUser(row: UserRow): SessionUser {
	return {
		id: row.id,
		fullName: row.full_name,
		title: row.title,
		role: row.role,
		responsibility: row.responsibility
	};
}

/** Everyone, for the "sign in as" picker. Nobody is signed in yet. */
export async function listUsers(db: Db): Promise<PickerUser[]> {
	const rows = await db.asVisitor((tx) =>
		tx.query<UserRow>(
			`select ${PICKER_COLUMNS} from nl.users
			 where kind = 'person'
			 order by active desc, id`
		)
	);
	return rows.map((row) => ({ ...toUser(row), active: row.active }));
}

/** The user behind a session cookie, if they exist and are still active. */
export async function findActiveUser(db: Db, id: number): Promise<SessionUser | null> {
	const [row] = await db.asVisitor((tx) =>
		tx.query<UserRow>(
			`select ${PICKER_COLUMNS} from nl.users
			 where id = $1 and active and kind = 'person'`,
			[id]
		)
	);
	return row ? toUser(row) : null;
}
