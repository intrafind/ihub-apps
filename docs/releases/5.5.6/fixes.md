# Fixes — 5.5.6

## iFinder Corpus Maps No Longer Report Every Facet Value as "(unknown)"

`iFinder_discover` produced a corpus map whose facet sections were empty of real
values: each one listed `(unknown) — 0 docs` instead of the sources, authors and
languages in the index.

iFinder answers with a `FacetsResult` envelope — `{ metadata, results: [...] }`
— and the normaliser read that envelope as if it were a map of facet names, so
it produced two facets literally called `metadata` and `results` and could not
find a value inside either. The envelope is now unwrapped first, and a facet the
API marks as truncated says so and points at `iFinder_getFacetValues` for the
rest.

Anything built on a corpus map written before this — an agent profile's
long-term memory, in particular — should be regenerated; the stored text has no
facet values in it.
