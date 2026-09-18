// The context engine's two tools for the assistant, in the registry's own
// shape (app/src/lib/server/assistant/tools.ts).
//
// They are defined here rather than in that file because it belongs to
// another feature. Adding them is one line each in TOOLS; the exact line is
// in the report and at the bottom of this file.
//
// The risk classes are the point:
//
//   get_context  READ. It serves a compiled bundle. Nothing is written.
//   explore_sources  ADDITIVE. It writes CLAIMS and nothing else: no fact, no
//                    decision, no mail. A claim is an observation with a
//                    citation on it, and an observation nobody promoted
//                    changes nothing a person can see except a queue. That is
//                    what makes it safe to let an agent run unasked, and it
//                    is also why it is not classed read.
import { z } from 'zod';
import { SURFACES, SUBJECT_KINDS, type Surface, type SubjectKind } from '$lib/context/types';
import { contextFor } from './read.ts';
import { exploreSources } from './explore.ts';

/**
 * The shape the assistant's registry expects. Repeated here rather than
 * imported, so this file does not depend on another feature's internals: if
 * that interface changes, the compiler says so at the registration line.
 */
export interface ContextToolContext {
	db: { asUser: <T>(userId: number, work: (tx: never) => Promise<T>) => Promise<T> };
	userId: number;
	today: string;
	round: number;
	requestId: (suffix: string) => string;
}

const subjectKind = z.enum(SUBJECT_KINDS);
const purpose = z.enum(SURFACES);

export const getContextInput = z.object({
	entity_kind: subjectKind.describe('customer, vendor, item or contact'),
	entity_id: z
		.string()
		.trim()
		.min(1)
		.max(40)
		.describe('The customer number, vendor number, part number or contact id'),
	purpose: purpose
		.optional()
		.describe(
			'What the context is for. It decides which facts are included: quoting, promising_date, replying_external, buying, shipping_paperwork, or internal_review. Defaults to internal_review.'
		)
});

export const exploreSourcesInput = z.object({
	entity_kind: subjectKind,
	entity_id: z.string().trim().min(1).max(40),
	attribute: z
		.string()
		.trim()
		.max(60)
		.optional()
		.describe(
			'One attribute from the data dictionary, to chase a single gap. Leave it out to read everything about this subject.'
		),
	limit: z.number().int().min(1).max(60).optional().describe('Documents to read at most. Default 25.')
});

export const GET_CONTEXT_DESCRIPTION = `What we know about one customer, supplier, part or contact, and where each piece came from.

Call this FIRST, before assembling anything about an account from other tools. It serves a compiled context bundle: only facts above the confidence bar, each with the source it came from, the date it was asserted and the exact words it was read out of, plus the house playbooks that apply to the purpose you name.

It answers in three ways and they are different. served true is context you may use. served true with bundle_stale true is the last good context and it says how old it is: use it and say so. served false means there is nothing above the bar, either because nothing was compiled or because everything for that purpose has expired; do not fill the gap yourself, say what is missing.

Pass the purpose that matches what you are doing. A fact only reaches the bundle if the data dictionary says that purpose may consume it, and an internal fact never reaches an external purpose. That is how a packaging requirement gets into a quote and a credit note does not.`;

export const EXPLORE_SOURCES_DESCRIPTION = `Go and look for evidence about a subject in the raw material: mail, the archive, attachment text, activity notes, staged ERP rows and the legacy CRM export.

Use it when get_context says something is missing or stale, or when the coverage list names a gap. Give it an attribute to chase one gap cheaply; leave the attribute out to read everything about that subject.

It writes CLAIMS, never facts. A claim is an observation with a citation, and it changes nothing anybody sees until the promotion rules run over it. It never sends anything. Its answer says what it found, what it could not parse, and what would promote and what would go to a person, so you can report the state honestly rather than guessing at it.`;

export interface ContextToolDeps {
	db: Parameters<typeof contextFor>[0];
}

/** The handler for get_context. */
export async function runGetContext(
	deps: ContextToolDeps,
	userId: number,
	input: z.infer<typeof getContextInput>
) {
	return contextFor(
		deps.db,
		userId,
		{ kind: input.entity_kind as SubjectKind, id: input.entity_id },
		(input.purpose ?? 'internal_review') as Surface
	);
}

/** The handler for explore_sources. */
export async function runExploreSources(
	deps: ContextToolDeps,
	userId: number,
	input: z.infer<typeof exploreSourcesInput>
) {
	const report = await exploreSources(
		deps.db,
		userId,
		{ kind: input.entity_kind as SubjectKind, id: input.entity_id },
		{ attribute: input.attribute ?? null, limit: input.limit ?? 25 }
	);
	// Said plainly in the result, because the model reads this and the class
	// of the tool is not visible to it.
	return { ...report, wrote: 'claims only. No fact was decided and nothing was sent.' };
}

/**
 * The two registry entries, ready to spread into the assistant's TOOLS array.
 * Typed loosely on purpose: the assistant's own `tool()` helper does the zod
 * to JSON Schema conversion, and this file must not import it.
 *
 * To register, in app/src/lib/server/assistant/tools.ts:
 *
 *   import { contextToolDefs } from '../context/tool.ts';
 *   ...
 *   export const TOOLS: Tool[] = [ ...existing, ...contextToolDefs() ];
 *
 * Each def has the fields ToolDef wants: name, risk, description, schema and
 * run.
 */
export function contextToolDefs() {
	return [
		{
			name: 'get_context',
			risk: 'read' as const,
			description: GET_CONTEXT_DESCRIPTION,
			schema: getContextInput,
			run: (ctx: ContextToolContext, input: z.infer<typeof getContextInput>) =>
				runGetContext({ db: ctx.db as unknown as ContextToolDeps['db'] }, ctx.userId, input)
		},
		{
			name: 'explore_sources',
			risk: 'additive' as const,
			description: EXPLORE_SOURCES_DESCRIPTION,
			schema: exploreSourcesInput,
			run: (ctx: ContextToolContext, input: z.infer<typeof exploreSourcesInput>) =>
				runExploreSources({ db: ctx.db as unknown as ContextToolDeps['db'] }, ctx.userId, input)
		}
	];
}
