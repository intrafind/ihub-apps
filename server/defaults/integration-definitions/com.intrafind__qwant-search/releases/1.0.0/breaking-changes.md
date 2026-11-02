# Qwant 1.0.0 — breaking changes

Config migration V204 replaced the `websearch` installation (`com.intrafind/web-search`, V195):

- `qwant` is installed where Qwant was reachable: the `websearch` installation's default engine was `auto` with no Brave or Staan key, or `qwant`, or an app named `qwant`. It takes over the enabled state of `websearch`.
- A fresh install ships no web search engine; apps with web search on use the model's native search until an engine is installed.
