/*
  The two decisions a modal makes, out where they can be tested.

  Everything else a modal needs (moving focus in, keeping focus inside,
  closing on Escape, making the page behind it inert) is what the platform's
  <dialog showModal()> already does, which is why this app uses one instead of
  building a focus trap by hand.
*/

/**
 * Was this click on the backdrop rather than on the panel?
 *
 * A modal <dialog> element's own box is the backdrop as far as the event is
 * concerned, so a click whose target is the dialog itself landed outside the
 * content. A click on anything inside it did not.
 */
export function isBackdropClick(target: EventTarget | null, dialog: Element | null): boolean {
	return Boolean(dialog) && target === dialog;
}

/**
 * Where the highlight goes when an arrow key is pressed in a list of
 * `length` options. It stops at the ends rather than wrapping: wrapping in a
 * command palette sends a person back to the top when they meant to keep
 * going, and they cannot tell which happened.
 */
export function moveHighlight(current: number, length: number, delta: number): number {
	if (length === 0) return 0;
	const next = current + delta;
	if (next < 0) return 0;
	if (next > length - 1) return length - 1;
	return next;
}
