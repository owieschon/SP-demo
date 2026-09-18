/*
  The list of short messages showing in the corner.

  A form's result belongs next to the form, which is what FormNotice is for.
  A toast is for the other case: something finished while a person was
  looking somewhere else, or the answer would otherwise appear off screen
  under a long table. Both say the same sentence the server sent.

  It is a $state array, mutated in place, so `export const` is allowed and
  every component that imports it sees the same list.
*/

export interface Toast {
	id: number;
	message: string;
	tone: 'ok' | 'error';
}

export const toasts = $state<Toast[]>([]);

let nextId = 1;

/** How long a message stays. An error stays longer: it has to be read. */
const LIFETIME = { ok: 4000, error: 8000 } as const;

export function showToast(message: string, tone: Toast['tone'] = 'ok'): number {
	const id = nextId++;
	toasts.push({ id, message, tone });
	// Browsers only: on the server there is nobody watching and no timer to
	// clean up.
	if (typeof window !== 'undefined') {
		window.setTimeout(() => dismissToast(id), LIFETIME[tone]);
	}
	return id;
}

export function dismissToast(id: number): void {
	const at = toasts.findIndex((toast) => toast.id === id);
	if (at !== -1) toasts.splice(at, 1);
}

/**
 * Raise a toast from a form action's result, using the same "did it fail"
 * rule as FormNotice so the two can never disagree.
 */
export function toastFromForm(
	form: { message?: string; failed?: boolean; conflict?: boolean } | null | undefined
): void {
	if (!form?.message) return;
	showToast(form.message, form.failed || form.conflict ? 'error' : 'ok');
}
