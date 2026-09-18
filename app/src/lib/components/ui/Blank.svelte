<script lang="ts">
	/*
	  There is no value here.

	  Thirty cells across the app printed a bare "·" for this. It reads fine
	  as a column of figures, and a screen reader says nothing at all for it,
	  so a row with three empty cells sounded like a row with three fewer
	  columns. The middot stays, because a dense table of right-aligned
	  numbers needs a mark to hold the column rather than the word "none"
	  breaking the rhythm, and the word goes beside it for anyone listening.

	    <td class="num">{n > 0 ? count(n) : ''}{#if n === 0}<Blank />{/if}</td>
	    <td>{bin || ''}{#if !bin}<Blank word="no bin" />{/if}</td>

	  `word` says what kind of nothing it is: something that was never set,
	  against something nobody knows.
	*/
	let {
		/** What a screen reader hears in place of the mark. */
		word = 'none'
	}: { word?: string } = $props();
</script>

<span aria-hidden="true">·</span><span class="sr-only">{word}</span>
