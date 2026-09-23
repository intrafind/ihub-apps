# Features — Unreleased

## Chat: tool activity shows what each call asked for and why it failed

The tool activity above an answer now lists the arguments of every tool call, not only its name,
so you can see how the assistant searched, not just that it did.

- An iFinder search shows its filters, sort order, result limit, offset and requested facets
  next to the query; a facet lookup shows which facet it enumerated.
- Every other tool shows the arguments it was called with.
- A failed call shows its error message under it instead of only in a tooltip on "Failed", so
  the reason is visible on touch screens too.
