// Compiled bundles over MCP, as resources.
//
// An outside agent (Claude Code, Cursor, Codex) gets EXACTLY the context our
// own agents get, byte for byte, with its version and its hash beside it. A
// resource rather than only a tool, because a resource is the thing an MCP
// client can attach, cache and cite, and because the bundle already is a
// document: it is compiled, hashed and versioned, which is the whole point of
// compiling it.
//
// The uri is stable and readable:
//
//   northline://context/customer/1214/quoting          the current version
//   northline://context/customer/1214/quoting?v=7      that exact version
//
// The payload is the same jsonb nl.context_for returns, so the test that
// compares the resource with nl.context_for is comparing one value with
// itself, which is what "byte for byte" has to mean to be worth saying.
//
// Registration is two lines in app/src/lib/server/mcp/server.ts and one in
// app/src/lib/server/mcp/tools.ts; both are at the bottom of this file and in
// the report.
import { z } from 'zod';
import { SUBJECT_KINDS, SURFACES, type SubjectKind, type Surface } from '$lib/context/types';
import type { Db } from '../db/types.ts';
import { contextFor, contextVersion, readCoverage } from './read.ts';

export const CONTEXT_URI_SCHEME = 'northline://context/';

export interface ContextResource {
	uri: string;
	name: string;
	title: string;
	description: string;
	mimeType: 'application/json';
}

export interface ContextResourceContents {
	uri: string;
	mimeType: 'application/json';
	text: string;
}

/**
 * The bundles worth listing. Every bundle for every subject would be
 * thousands of rows on a full world, so the listing is the subjects with the
 * most facts, at the purposes that actually carry any.
 */
export async function listContextResources(
	db: Db,
	userId: number,
	limit = 40
): Promise<ContextResource[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.query<{
			subject_kind: SubjectKind;
			subject_id: string;
			purpose: Surface;
			version: number;
			name: string | null;
			facts: number;
			built_at: Date;
		}>(
			`select b.subject_kind, b.subject_id, b.purpose, b.version,
			        coalesce(cu.name, ve.name, it.description, ct.full_name) as name,
			        coalesce((b.inputs ->> 'facts')::int, 0) as facts,
			        b.built_at
			 from nl.context_bundles b
			 left join nl.customers cu on b.subject_kind = 'customer' and cu.customer_no = b.subject_id
			 left join nl.vendors ve on b.subject_kind = 'vendor' and ve.vendor_no = b.subject_id
			 left join nl.items it on b.subject_kind = 'item' and it.item_no = b.subject_id
			 left join nl.contacts ct on b.subject_kind = 'contact' and ct.id::text = b.subject_id
			 where b.is_current and coalesce((b.inputs ->> 'facts')::int, 0) > 0
			 order by coalesce((b.inputs ->> 'facts')::int, 0) desc, b.subject_id, b.purpose
			 limit $1`,
			[limit]
		)
	);

	return rows.map((row) => ({
		uri: `${CONTEXT_URI_SCHEME}${row.subject_kind}/${encodeURIComponent(row.subject_id)}/${row.purpose}`,
		name: `context-${row.subject_kind}-${row.subject_id}-${row.purpose}`,
		title: `${row.name ?? row.subject_id} for ${row.purpose.replace(/_/g, ' ')}`,
		description:
			`${row.facts} verified fact(s) with citations, plus the playbooks in scope. ` +
			`Version ${row.version}, compiled ${row.built_at.toISOString()}.`,
		mimeType: 'application/json' as const
	}));
}

interface ParsedUri {
	kind: SubjectKind;
	id: string;
	purpose: Surface;
	version: number | null;
}

/** Read one of our uris, or refuse it. No guessing at a malformed one. */
export function parseContextUri(uri: string): ParsedUri | null {
	if (!uri.startsWith(CONTEXT_URI_SCHEME)) return null;
	const [path, query] = uri.slice(CONTEXT_URI_SCHEME.length).split('?');
	const parts = path.split('/').filter(Boolean);
	if (parts.length !== 3) return null;
	const [kind, rawId, rawPurpose] = parts;
	if (!(SUBJECT_KINDS as readonly string[]).includes(kind)) return null;
	if (!(SURFACES as readonly string[]).includes(rawPurpose)) return null;
	const id = decodeURIComponent(rawId);
	if (!id || id.length > 60) return null;

	let version: number | null = null;
	if (query) {
		const asked = new URLSearchParams(query).get('v');
		if (asked !== null) {
			if (!/^\d{1,9}$/.test(asked)) return null;
			version = Number(asked);
		}
	}
	return { kind: kind as SubjectKind, id, purpose: rawPurpose as Surface, version };
}

/**
 * Serve one bundle. A uri we do not recognise answers null so the endpoint
 * can raise the protocol's own "no such resource", and a version that does
 * not exist does the same: a frozen version that has been rebuilt away is a
 * missing resource, not an empty one.
 */
export async function readContextResource(
	db: Db,
	userId: number,
	uri: string
): Promise<ContextResourceContents | null> {
	const parsed = parseContextUri(uri);
	if (!parsed) return null;

	const bundle = parsed.version === null
		? await contextFor(db, userId, { kind: parsed.kind, id: parsed.id }, parsed.purpose)
		: await contextVersion(db, userId, { kind: parsed.kind, id: parsed.id }, parsed.purpose, parsed.version);
	if (!bundle) return null;

	return {
		uri,
		mimeType: 'application/json',
		// The payload exactly as nl.context_for returns it. No reshaping: an
		// outside agent and an inside one read the same bytes, which is the
		// claim this feature is making.
		text: JSON.stringify(bundle)
	};
}

// ---------------------------------------------------------------------------
// The tool, for a client that has no resource support
// ---------------------------------------------------------------------------

export const mcpGetContextInput = z.object({
	entity_kind: z.enum(SUBJECT_KINDS),
	entity_id: z.string().trim().min(1).max(40),
	purpose: z.enum(SURFACES).optional(),
	version: z.number().int().min(1).max(999_999).optional()
});

export const MCP_GET_CONTEXT_DESCRIPTION = `The compiled context bundle for one customer, supplier, part or contact: the facts above the confidence bar with their citations, the playbooks that apply, and the policy values in force. The same bytes the resource northline://context/<kind>/<id>/<purpose> serves, and the same bytes the app's own agents read.

Name the purpose that matches what you are doing (quoting, promising_date, replying_external, buying, shipping_paperwork, internal_review): the data dictionary decides which facts a purpose may consume, and an internal fact never reaches an external one. Pass a version to read a frozen bundle rather than the current one, which is how an evaluation replays against context that cannot move under it.`;

/** The read-scope handler. Nothing here writes. */
export async function runMcpGetContext(
	db: Db,
	userId: number,
	input: z.infer<typeof mcpGetContextInput>
) {
	const purpose = (input.purpose ?? 'internal_review') as Surface;
	const subject = { kind: input.entity_kind as SubjectKind, id: input.entity_id };
	const bundle = input.version
		? await contextVersion(db, userId, subject, purpose, input.version)
		: await contextFor(db, userId, subject, purpose);
	if (!bundle) {
		return {
			error: `There is no version ${input.version} of the ${purpose} bundle for ${input.entity_kind} ${input.entity_id}.`
		};
	}
	return bundle;
}

/** Coverage over MCP, so an outside agent can see the gaps too. */
export async function runMcpContextCoverage(db: Db, userId: number) {
	const rows = await readCoverage(db, userId, 200);
	return {
		attributes: rows.length,
		worst: rows.slice(0, 20),
		note: 'Rows are worst-covered first. missing is a work list: explore_sources fills it.'
	};
}

/*
 * How to register, when the MCP server's own files can be edited:
 *
 * In app/src/lib/server/mcp/server.ts, in buildServer:
 *
 *   { capabilities: { tools: {}, resources: {} }, instructions: INSTRUCTIONS }
 *
 *   server.setRequestHandler(ListResourcesRequestSchema, async () => ({
 *     resources: await listContextResources(deps.db, token.userId)
 *   }));
 *   server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
 *     const contents = await readContextResource(deps.db, token.userId, request.params.uri);
 *     if (!contents) throw new McpError(ErrorCode.InvalidParams, `No resource at ${request.params.uri}.`);
 *     return { contents: [contents] };
 *   });
 *
 * In app/src/lib/server/mcp/tools.ts, one entry in MCP_TOOLS with
 * scope 'read', readOnly true, mcpGetContextInput as its schema and
 * runMcpGetContext as its run.
 */
