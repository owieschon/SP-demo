// One of a draft's attachments, exactly as it arrived.
//
// Row-level security decides who may read it: an attachment belongs to its
// draft, and a draft belongs to the person who made it or to an admin
// (migration 0020). Somebody else's attachment reads as missing, so this
// answers 404 for both cases and never tells one from the other.
import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { fileResponse } from '$lib/server/documents/http';
import { readAttachment } from '$lib/server/documents/store';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params }) => {
	const file = await readAttachment(
		await getDb(),
		locals.user!.id,
		Number(params.id),
		Number(params.attachment)
	);
	if (!file) error(404, 'That file is not on this request.');

	// The stored media type, never anything the browser said on the way in.
	return fileResponse(file.bytes, file.mediaType, file.fileName);
};
