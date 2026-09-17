// Sample export files to try the workflow with, made from whatever world
// this copy of the app runs on (see $lib/server/exports/samples.ts).
import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { sampleFile } from '$lib/server/exports/samples';
import { SAMPLE_KINDS, type SampleKind } from '$lib/components/exports/types';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params }) => {
	const kind = SAMPLE_KINDS.find((s) => s.kind === params.kind)?.kind as SampleKind | undefined;
	if (!kind) error(404, `There is no sample called ${params.kind}.`);

	const db = await getDb();
	const file = await db.asUser(locals.user!.id, (tx) => sampleFile(tx, kind));
	return new Response(file.text, {
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': `attachment; filename="${file.fileName}"`,
			// The same world on the same day gives the same file.
			'cache-control': 'private, max-age=300'
		}
	});
};
