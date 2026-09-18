import { error } from '@sveltejs/kit';
import { caseFilePath, readEvalCase } from '$lib/server/harness/trust';
import type { PageServerLoad } from './$types';

/*
  One eval case, as the file itself.

  /agents says "23 of 26 cases fully right". A person who does not already
  trust the page has no reason to believe that, and a score with no way to see
  a case is a score you have to take on faith. This is the way in: the message
  that went in, and the answer the suite expects out, exactly as they sit on
  disk.

  Nothing here runs a case. Running the desk suite needs a built world and
  takes minutes, so a page load must not, and a page that showed a freshly
  computed result would also be a second place the score is decided. The
  figures stay the runner's; this shows the input.

  The suite folder is checked against the four the runner knows and the case
  name against the runner's own file pattern, inside readEvalCase, so the path
  is never assembled out of whatever arrived in the URL.
*/
export const load: PageServerLoad = async ({ params }) => {
	const found = readEvalCase(params.suite, params.case);
	if (!found) {
		error(404, `There is no eval case called ${params.case} in ${params.suite}.`);
	}
	return {
		...found,
		/** Where the file lives, so a person can open it in the repository. */
		path: caseFilePath(found.folder, found.name)
	};
};
