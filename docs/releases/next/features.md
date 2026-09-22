# Features — Unreleased

## Web Search: The Model Can Open and Read Pages

Apps with web search can now open a page, not just search. When web search runs through Brave,
Staan or Qwant, the model also gets a page reader. It uses it to read a search result in full, or
a URL the user pasted, where before it only saw short excerpts of the top results.

- Works for web pages and PDFs. The same protection against internal and private addresses applies.
- It is offered automatically. No app changes are needed. To turn it off, disable the
  **Web Page Reader** tool (`webContentExtractor`) under **Admin → Tools**.
- It is not added when the model's own native search (Gemini, OpenAI, Claude) handles the request.
