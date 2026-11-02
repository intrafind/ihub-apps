# Brave Search 1.0.0 — breaking changes

Config migration V204 replaced the `websearch` installation (`com.intrafind/web-search`, V195):

- `brave` is installed where a Brave key was configured: the credential the `websearch` installation referenced (it moves to `apiKeyRef`) or `BRAVE_SEARCH_API_KEY`. It takes over the enabled state of `websearch`.
- An install without a Brave key gets no `brave` installation; install it from the catalog when you need it.
