/*
  What a DataTable header link points at, and what its footer says.

  Sorting a list is a navigation, not a piece of component state: the header
  is an anchor, the choice lives in the query string, and the view a person is
  looking at is a link they can send to somebody. The arithmetic for that is
  here so it can be tested without a browser.
*/

/** One column's sort keys. `desc` is optional: some sorts only go one way. */
export interface ColumnSort {
	/** The query value that sorts by this column, ascending. */
	asc: string;
	/** The query value for the other direction, when there is one. */
	desc?: string;
}

/** One column of a DataTable. The cells themselves are the caller's snippet. */
export interface Column {
	/** Unique within the table; the key for the header cells. */
	key: string;
	header: string;
	/** Figures go right. Anything a person reads goes left. */
	align?: 'left' | 'right';
	/** A CSS width, when one column should take the room. */
	width?: string;
	/** Makes the header a link that sorts, through the URL. */
	sort?: ColumnSort;
	/** Hide the header text but keep it for a screen reader (action columns). */
	hideHeader?: boolean;
}

/**
 * The query string for a sort, keeping every other parameter and going back
 * to page one. A person who re-sorts a list wants the top of the new order,
 * not page four of it.
 */
export function sortSearch(
	search: string,
	param: string,
	value: string,
	pageParam = 'page'
): string {
	const params = new URLSearchParams(search);
	params.set(param, value);
	params.delete(pageParam);
	const query = params.toString();
	return query ? `?${query}` : '?';
}

/**
 * Which sort the header link should ask for next.
 *
 * Not sorted by this column: ask for its default direction. Already sorted
 * ascending: ask for descending, if it has one. Already descending: ask for
 * ascending again, so a person can always get back.
 */
export function nextSortValue(sort: ColumnSort, current: string | null): string {
	if (current === sort.asc) return sort.desc ?? sort.asc;
	if (sort.desc && current === sort.desc) return sort.asc;
	return sort.asc;
}

/** What `aria-sort` on the header cell should be. */
export function ariaSortValue(
	sort: ColumnSort | undefined,
	current: string | null
): 'ascending' | 'descending' | 'none' | undefined {
	if (!sort) return undefined;
	if (current === sort.asc) return 'ascending';
	if (sort.desc && current === sort.desc) return 'descending';
	return 'none';
}

/**
 * The footer line under a table. It always says how many rows there are in
 * total, because fourteen tables in this app used to show the server's first
 * N and read as the whole thing.
 */
export function rowCountLine(input: {
	shown: number;
	total: number;
	noun: string;
	/** How the rows were sorted, so a reader knows which N these are. */
	order?: string;
}): string {
	const { shown, total, noun, order } = input;
	const number = new Intl.NumberFormat('en-US');
	if (total <= shown) {
		return `${number.format(total)} ${noun}`;
	}
	const order_ = order ? `, ${order}` : '';
	return `${number.format(shown)} of ${number.format(total)} ${noun}${order_}`;
}
