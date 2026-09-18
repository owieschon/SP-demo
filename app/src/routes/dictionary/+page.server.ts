// /dictionary: what every field a person or an agent reads actually means.
//
// The same rows nl.describe_data() hands the assistant and the MCP server, so
// the page and the tools cannot describe the data differently. The search is
// done in the browser because the whole dictionary is a couple of hundred
// short rows: sending it once and filtering there is quicker than a round
// trip per keystroke, and it keeps working while the connection is slow.
import { getDb } from '$lib/server/db';
import { dictionaryGaps, readDictionaryByEntity } from '$lib/server/policy/dictionary';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const user = locals.user!;
	const db = await getDb();

	return {
		// Not awaited: the page arrives first and the tables stream in.
		entities: readDictionaryByEntity(db, user.id),
		// A dictionary nobody checks is worse than no dictionary, so the page
		// says out loud when it has fallen behind the schema. The tests require
		// this to be empty.
		gaps: dictionaryGaps(db, user.id)
	};
};
