// Write functions in the database raise errors with our own SQLSTATE codes
// (NL401, NL403, ...). This turns them into HTTP statuses the pages and the
// assistant can act on. Anything else is a real failure and is rethrown.

const STATUS_BY_CODE: Record<string, number> = {
	NL401: 401, // no active user
	NL403: 403, // not allowed (owner or admin only)
	NL404: 404, // no such row
	NL409: 409, // changed since it was loaded, or a request id reused
	NL422: 422 // the request does not make sense right now
};

export class AppError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

export function toAppError(error: unknown): AppError | null {
	if (error instanceof AppError) return error;
	if (typeof error === 'object' && error !== null && 'code' in error) {
		const code = String((error as { code: unknown }).code);
		const status = STATUS_BY_CODE[code];
		if (status) return new AppError(status, code, String((error as { message?: unknown }).message ?? ''));
	}
	return null;
}

/** Run a database write; turn our own errors into AppError, rethrow the rest. */
export async function guarded<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		throw toAppError(error) ?? error;
	}
}
