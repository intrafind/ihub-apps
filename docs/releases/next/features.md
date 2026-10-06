# Features — Unreleased

## Library: Tidier Search and Filter Bar

The top of the library (`/prompts`) is cleaner: search, sort and the "New" button line up at the
same height, and all filters sit together in one row instead of stacked lanes.

- Type (All, Prompts, Skills) and scope (All, Mine, Shared with me, Global, Favorites) are matching
  segmented controls side by side.
- Prompt categories are a "Category" dropdown in the same row; the selected category shows its
  configured color as a dot. The dropdown always offers "All categories", so
  `promptsList.categories.showAll` no longer has an effect on the library.
- On phones, sort and "New" share a row and the filters wrap instead of scrolling out of view.
