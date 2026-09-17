// The eval emails double as samples on the intake page: they are invented,
// and they show every case the validator handles.
//
// Vite reads the files at build time (import.meta.glob with ?raw), so the
// samples ship inside the server bundle and nothing is read from disk at
// run time.
const files = import.meta.glob('../../../../../evals/rfq/cases/*.txt', {
	query: '?raw',
	import: 'default',
	eager: true
}) as Record<string, string>;

export interface Sample {
	/** "03-forwarded-chain" */
	name: string;
	/** "Forwarded chain" */
	label: string;
	text: string;
}

export const SAMPLES: Sample[] = Object.entries(files)
	.map(([path, text]) => {
		const name = path.split('/').pop()!.replace(/\.txt$/, '');
		const words = name.replace(/^\d+-/, '').replace(/-/g, ' ');
		return { name, label: words[0].toUpperCase() + words.slice(1), text };
	})
	.sort((a, b) => a.name.localeCompare(b.name));
