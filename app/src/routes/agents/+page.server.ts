import { randomUUID } from 'node:crypto';
import { fail } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { toAppError } from '$lib/server/errors';
import { pauseInput, readPauses, setPause } from '$lib/server/harness/ladder';
import {
	autonomyGrantInput,
	autonomyRevokeInput,
	isAdmin,
	mayPromote,
	NotAPrincipal,
	revokeGrantedAutonomy,
	setGrantedAutonomy
} from '$lib/server/harness/promotion';
import { listLevelChanges, listUndoable, runSources } from '$lib/server/harness/runs';
import { AGENTS, type AgentId } from '$lib/server/harness/scope';
import {
	guardrailRoster,
	readAgentTrust,
	readEvalSummary,
	readRefusals,
	readTrustTrend
} from '$lib/server/harness/trust';
import { undoAction } from '$lib/server/harness/wake';
import { isTokenLevel, listTokens, setTokenLevel } from '$lib/server/mcp/tokens';
import type { Actions, PageServerLoad } from './$types';

/*
  /agents: whether these agents can be trusted, and what a person does about
  it if not.

  It is a trust surface, not a dashboard. Every figure on it is here because
  it changes what somebody decides about an agent: how much it handled, how
  much of that a person let through, how often they had to correct it, what it
  refused to do, where its autonomy sits, and whether it is stopped. Anything
  that does not change that decision is deliberately not here, however easy it
  would be to add.

  Reading is open to everybody, on the same principle /people uses: what the
  agents may do is not a secret inside a company, and a person cannot judge a
  draft without knowing what the thing that wrote it is allowed to do. Writing
  needs the change_policy authority, which the database checks; this page only
  decides whether to draw the controls.

  The order of the sections is an argument. The refusals come high, because
  what an agent declined to do is the most persuasive thing in the whole app
  and it is usually the thing nobody shows.
*/

function agentParam(value: string | null): AgentId | null {
	return AGENTS.includes(value as AgentId) ? (value as AgentId) : null;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	// hooks.server.ts guarantees a signed-in user on this page.
	const user = locals.user!;
	const db = await getDb();
	const agent = agentParam(url.searchParams.get('agent'));
	// Asked once: it gates both the controls and the token list below.
	const mayChange = await mayPromote(db, user.id);

	const [row] = await db.asUser(user.id, (tx) =>
		tx.sql<{ today: string }>`select nl.today() as today`
	);

	return {
		today: row.today,
		agent,
		// Awaited: the row per agent and the refusals are the page. Arriving
		// without them would be arriving without the answer.
		agents: await readAgentTrust(db, user.id),
		/*
		  The global pause, read on its own.

		  Every agent showing as stopped is not the same fact as the global
		  brake being on: five separate pauses look identical from the agent
		  rows. The top button lifts the 'all' row specifically, so it has to
		  know whether that row is live rather than infer it.
		*/
		globalPause: (await readPauses(db, user.id)).find((p) => p.agent === 'all') ?? null,
		// Each refusal with the rule that refused, and where that rule is
		// really enforced. A count on its own is not an argument.
		refusals: await readRefusals(db, user.id, 12),
		// Every named check, including the ones that have never had to refuse
		// anything, so the page answers "what would stop it" as well.
		roster: guardrailRoster(),
		mayPromote: mayChange,
		/*
		  The MCP tokens, with the rung each one stands on.

		  They belong on this page rather than only on the connect page, because
		  a token IS an agent: it acts as a person, it has a level on the same
		  ladder, and the brake above stops it. The connect page mints and
		  revokes; this page is where its autonomy is raised and lowered, beside
		  every other agent's.

		  Shown only to somebody who may change a policy, which is the same gate
		  the controls have. Reading the rest of this page is open to everybody
		  (see the note at the top), but who holds a credential is not the same
		  kind of fact as what an agent is allowed to do.
		*/
		mcpTokens: mayChange ? (await listTokens(db, user.id)).filter((t) => t.revokedAt === null) : [],
		/*
		  Whether this person may LET a pause go, which is an admin's alone.
		  Pulling it needs nothing at all, so there is deliberately no flag
		  for that: the stop button is drawn for everybody.
		*/
		mayRelease: await isAdmin(db, user.id),
		/*
		  Which of the feature tables the unified run view is actually built
		  from in this database. It matters on this page: the procurement
		  desk's own table is not in the view yet, so its row reads as nothing
		  yet, and the page should say why rather than let it look like an
		  agent that never works.
		*/
		sources: await runSources(db, user.id),
		// The evals are file reads, so there is nothing to stream.
		evals: readEvalSummary(),
		// Not awaited on purpose: these three stream in behind the page, with
		// skeleton rows meanwhile. The trend walks every run in the window and
		// the level history joins nl.users, and neither is worth waiting on
		// before the agent rows are on screen.
		trend: readTrustTrend(db, user.id, { agent, weeks: 8 }),
		undoable: listUndoable(db, user.id, 10),
		levelChanges: listLevelChanges(db, user.id, 8),
		// One id per page load. Each form makes its own id from it, so sending
		// the same form twice sends the same id and the database writes once.
		requestId: randomUUID()
	};
};

/*
  Turn a refusal from the database into something the page can show.

  `failed: true` is set on every refusal because FormNotice reads that field
  to decide whether to announce the message with role="alert" instead of
  role="status". Without it a refusal is rendered as though it had worked,
  which on this page would mean a person believing they had raised an agent's
  autonomy when the database had said no.
*/
async function run<T>(work: () => Promise<T>, done: string) {
	try {
		await work();
		return { message: done };
	} catch (error) {
		if (error instanceof NotAPrincipal) {
			return fail(422, { message: error.message, code: 'NL422', failed: true });
		}
		const refusal = toAppError(error);
		if (!refusal) throw error;
		return fail(refusal.status, {
			message: refusal.message,
			code: refusal.code,
			failed: true,
			conflict: refusal.status === 409
		});
	}
}

export const actions: Actions = {
	/*
	  The write this page exists for. It is nl.grant_authority, the same call
	  that raises a person's approval ceiling, aimed at an agent's row in
	  nl.users. The gate, the audit row and the effective dating are the
	  database's, not this handler's.
	*/
	autonomy: async ({ locals, request }) => {
		const parsed = autonomyGrantInput.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) {
			return fail(400, { message: 'A level is 0 to 3, and a date is YYYY-MM-DD.' });
		}
		const db = await getDb();
		const when = parsed.data.startsOn ? ` from ${parsed.data.startsOn}` : '';
		return run(
			() => setGrantedAutonomy(db, locals.user!.id, parsed.data),
			`Saved the autonomy grant${when}.`
		);
	},

	/*
	  The same write, aimed at one token.

	  An MCP token has its own agent-kind principal in nl.users (migration
	  0044), so raising its level is nl.grant_authority on that principal:
	  identical call, identical table, identical audit row, identical gate. The
	  only thing this handler adds is resolving which principal a token id
	  means, and it does that in the database rather than trusting the form.
	*/
	tokenAutonomy: async ({ locals, request }) => {
		const form = Object.fromEntries(await request.formData());
		const tokenId = Number(form.tokenId);
		const level = String(form.level ?? '');
		const requestId = String(form.requestId ?? '');
		const startsOn = String(form.startsOn ?? '');
		if (!Number.isInteger(tokenId) || tokenId <= 0 || requestId.length < 8) {
			return fail(400, { message: 'The form is out of date. Reload the page and try again.' });
		}
		if (!isTokenLevel(level)) {
			return fail(400, { message: 'A token sits at suggest, act with review, or act.' });
		}
		if (startsOn !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(startsOn)) {
			return fail(400, { message: 'A date is YYYY-MM-DD, or leave it blank for today.' });
		}
		const db = await getDb();
		return run(
			() =>
				setTokenLevel(db, locals.user!.id, {
					tokenId,
					level,
					startsOn: startsOn === '' ? null : startsOn,
					note: String(form.note ?? '').slice(0, 300),
					requestId
				}),
			startsOn === ''
				? 'Saved. The token is on its new level from its next call.'
				: `Saved. The token moves on ${startsOn}.`
		);
	},

	revokeAutonomy: async ({ locals, request }) => {
		const parsed = autonomyRevokeInput.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Pick an agent.' });
		const db = await getDb();
		return run(
			() => revokeGrantedAutonomy(db, locals.user!.id, parsed.data),
			'Took the autonomy grant away, from today.'
		);
	},

	/*
	  The brake. Anybody signed in may pull it, because a demo where nobody can
	  stop the agents is not a trust surface; letting it go again is an
	  admin's, and nl.set_agent_pause decides that, not this page.
	*/
	pause: async ({ locals, request }) => {
		const form = Object.fromEntries(await request.formData());
		const parsed = pauseInput.safeParse({ ...form, paused: form.paused === 'true' });
		if (!parsed.success) return fail(400, { message: 'Pick an agent to stop or let go.' });
		const db = await getDb();
		return run(
			() => setPause(db, locals.user!.id, parsed.data),
			parsed.data.paused ? 'Stopped. It will draft and hold.' : 'Let go. It is running again.'
		);
	},

	/** Take back something an agent did on its own, inside its window. */
	undo: async ({ locals, request }) => {
		const form = Object.fromEntries(await request.formData());
		const actionId = Number(form.actionId);
		const requestId = String(form.requestId ?? '');
		if (!Number.isInteger(actionId) || actionId <= 0 || requestId.length < 8) {
			return fail(400, { message: 'That is not something to take back.' });
		}
		const db = await getDb();
		return run(
			() =>
				undoAction(db, locals.user!.id, {
					actionId,
					reason: String(form.reason ?? '').slice(0, 300),
					requestId
				}),
			'Taken back.'
		);
	}
};
