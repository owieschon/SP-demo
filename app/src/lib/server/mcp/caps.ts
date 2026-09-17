// The MCP server's limits, in one place.
//
// The size cap is the assistant's own constant, imported rather than copied,
// so a tool result is exactly the same size whether the in-app assistant or an
// outside agent asked for it. The daily cap is per token and is counted in the
// database (migration 0024), like the assistant's, so restarting the app does
// not reset the day.
import { MAX_TOOL_RESULT_BYTES } from '../assistant/caps.ts';

export { MAX_TOOL_RESULT_BYTES };

/** Tool calls one token may make in a day. */
export const DEFAULT_DAILY_PER_TOKEN = 200;

export interface McpLimits {
	perTokenPerDay: number;
}

export const DEFAULT_LIMITS: McpLimits = { perTokenPerDay: DEFAULT_DAILY_PER_TOKEN };

/** Read the cap from the environment, falling back to the default. */
export function readMcpLimits(env: Record<string, string | undefined>): McpLimits {
	const parsed = Number(env.MCP_DAILY_PER_TOKEN);
	return {
		perTokenPerDay:
			Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_DAILY_PER_TOKEN
	};
}
