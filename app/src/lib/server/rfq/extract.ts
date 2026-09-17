// One entry point for both extractors.
//
//   rules   no API key, deterministic; the default everywhere
//   claude  a live model call; only when the server has a key AND the person
//           unlocked live mode with the passphrase (see live.ts)
import { extractWithClaude, type ClaudeExtractorOptions } from './claude.ts';
import { extractWithRules } from './rules.ts';
import type { Extraction } from './schema.ts';

export type ExtractOptions = { today: string } & (
	| { mode: 'rules' }
	| { mode: 'claude'; claude: ClaudeExtractorOptions }
);

export async function extract(source: string, options: ExtractOptions): Promise<Extraction> {
	if (options.mode === 'claude') {
		return extractWithClaude(source, options.today, options.claude);
	}
	return { draft: extractWithRules(source, options.today), extractor: 'rules', model: null, usage: null };
}
