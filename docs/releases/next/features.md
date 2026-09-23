# Features — Unreleased

## Outlook: the default starter prompts are the start page's quick starters

The starter prompts configured under **Admin → Office Integration** ("Summarize this email", the
calendar set inside a meeting, …) now appear only on the task pane's start page, as quick starters
for the default chat app. Opening an app shows that app's own starter prompts; an app without any
shows none, instead of falling back to the Outlook defaults.

To keep a prompt available inside a particular app, add it to that app's starter prompts. With the
landing view set to **All apps** there is no start page, so the Outlook defaults are not shown.

## Chat: tool activity shows what each call asked for and why it failed

The tool activity above an answer now lists the arguments of every tool call, not only its name,
so you can see how the assistant searched, not just that it did.

- An iFinder search shows its filters, sort order, result limit, offset and requested facets
  next to the query; a facet lookup shows which facet it enumerated.
- Every other tool shows the arguments it was called with.
- A failed call shows its error message under it instead of only in a tooltip on "Failed", so
  the reason is visible on touch screens too.

## Outlook Add-in: faster repeat opens on slow connections

The task pane's JavaScript and CSS bundles now carry a long-lived cache header, so the browser
reuses them from disk instead of re-fetching on every open. Previously every asset was revalidated
with the server on each open, which added a round trip per file — noticeable on slow or
high-latency connections. The `taskpane.html`, `commands.html` and `callback.html` pages
themselves still revalidate on every load, so a new deployment is always picked up.
