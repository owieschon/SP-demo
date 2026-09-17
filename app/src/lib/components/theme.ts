// The color theme a visitor picked. Stored in a cookie so the server can
// write it into <html data-theme="..."> before the page is sent.

export type Theme = 'light' | 'dark' | 'system';

export const THEMES: Theme[] = ['light', 'dark', 'system'];

export const THEME_COOKIE = 'theme';

/** Anything that is not a known theme (missing, tampered) means "system". */
export function readTheme(value: string | null | undefined): Theme {
	return value === 'light' || value === 'dark' ? value : 'system';
}
