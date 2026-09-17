// One extra refusal code on top of lib/server/errors.ts.
//
// The daily call cap raises NL429 (migration 0017). The shared mapper does not
// know that code, so this file maps it and hands everything else to the shared
// one. It is a separate file so nothing outside Ask Northline changes.
import { AppError, toAppError } from '../errors.ts';

/** The database's code for "you have used up today's calls". */
export const CAP_CODE = 'NL429';

export function toAskError(error: unknown): AppError | null {
	const shared = toAppError(error);
	if (shared) return shared;
	if (typeof error === 'object' && error !== null && 'code' in error) {
		if (String((error as { code: unknown }).code) === CAP_CODE) {
			return new AppError(429, CAP_CODE, String((error as { message?: unknown }).message ?? ''));
		}
	}
	return null;
}

/** Run a database call; turn our own refusals into AppError, rethrow the rest. */
export async function askGuarded<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		throw toAskError(error) ?? error;
	}
}

/** Was this refusal the daily cap? */
export function isCapReached(error: unknown): boolean {
	return error instanceof AppError && error.code === CAP_CODE;
}
