// The headers a file download needs, in one place.
//
// Two rules matter here:
//   * the media type is the one that was stored, decided from the file's own
//     bytes when it arrived, never the one the browser claimed,
//   * the browser is told to save the file, not to display it, and not to
//     sniff a type of its own, so nothing a customer sends can ever run as a
//     page inside the app.
//
// A file name in a header is a small trap: a quote or a line break in it
// would end the header early, and a non-ASCII character cannot travel in it
// at all. So the name is cleaned for the plain form and repeated in the
// RFC 5987 form for browsers that read it.

/** A file name safe to put in a header: ASCII, no quotes, no control codes. */
export function safeFileName(name: string, fallback: string): string {
	const clean = name
		.replace(/[\r\n"\\]/g, '')
		// A path separator in a download name is never useful and often a trick.
		.replace(/[/\\]/g, '-')
		.split('')
		.filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) < 127)
		.join('')
		.trim();
	return clean === '' ? fallback : clean.slice(0, 120);
}

/** `attachment; filename="parts-list.csv"; filename*=UTF-8''parts-list.csv` */
export function contentDisposition(name: string, fallback = 'download'): string {
	const plain = safeFileName(name, fallback);
	return `attachment; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(name || fallback)}`;
}

/** The response for a file the app hands back. */
export function fileResponse(bytes: Uint8Array, mediaType: string, fileName: string): Response {
	// A fresh copy in a plain ArrayBuffer, which is what Response takes.
	const body = new Uint8Array(bytes);
	return new Response(body, {
		headers: {
			'content-type': mediaType,
			'content-length': String(body.byteLength),
			'content-disposition': contentDisposition(fileName),
			// Never let a browser decide the type is something else.
			'x-content-type-options': 'nosniff',
			// A customer's document, and a quote with prices on it: no cache
			// anywhere but this browser, and not on disk.
			'cache-control': 'private, no-store'
		}
	});
}
