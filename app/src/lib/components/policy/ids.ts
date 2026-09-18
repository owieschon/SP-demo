// A fresh request id per submit.
//
// Every write in this app claims a request id, so a retried form returns the
// first answer instead of writing twice. That only works if a deliberate
// second attempt carries a new id, which is what this is for.
export function freshRequestId(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	// A browser without randomUUID still needs something long enough for the
	// database to accept it (8 to 100 characters).
	return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
