# Fixes — 5.5.14

## Chat: iFinder searches are no longer shown as web searches

Answers from apps that search iFinder, such as the iFinder Search app, said "Searched the web" and
carried a "Based on web search" badge, although they never left the organisation's document index.

- The tool activity above the answer now says "Searched documents", and the badge says "Based on
  iFinder documents".
- Reading a document with `iFinder_getContent` now names the document it read, linked when iFinder
  provides a deep link. The search hit it came from is marked "Read", and the summary counts
  documents read.
- iFinder hits without a browser link are still listed, by title.
- Searches of configured sources are also shown as document searches rather than web searches.
