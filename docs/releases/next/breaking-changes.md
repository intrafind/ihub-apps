# Breaking Changes — Unreleased

## Qwant Is No Longer a Web Search Engine

Qwant blocks requests from most data-centre IP addresses, so it rarely answered. iHub now ships two
web search engines: **Brave Search** and **Staan**. Both need an API key.

Migration V264 runs on the first start and changes what refers to Qwant:

- The installation of `com.intrafind/qwant-search` (`qwant`) is removed from **Admin →
  Integrations**.
- Apps with `websearch.provider: "qwant"` are set to `auto`: the first engine the user may use
  (Brave, then Staan, then any third-party engine).
- Grants of `qwant` or `com.intrafind/qwant-search` are removed from the groups. The grant "All web
  search engines" (`type:web-search`) is not touched.

Nothing replaces it. If an install used Qwant, **install and configure Brave Search or Staan** under
**Admin → Integrations → Catalog → Web search**. Until then an app with web search on searches only
on models with native search (Google, OpenAI, Anthropic).

Also gone:

- The environment variables `QWANT_SEARCH_ENDPOINT` and `QWANT_SEARCH_USER_AGENT`.
- The tool id `qwantSearch`.
- The `blocked` result and its `blockedBy` field of the web search connection test; they only
  reported Qwant's bot protection.
