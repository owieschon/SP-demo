/*
  Whether the command palette is open.

  It lives outside the component because there is exactly one palette in the
  app and more than one button that opens it: one in the top bar, one in the
  phone bar. Rendering the component twice put two <dialog> elements and two
  window key listeners on the page, so Ctrl+K opened both and Escape closed
  one of them.
*/

export const palette = $state({ open: false });

export function openPalette(): void {
	palette.open = true;
}
