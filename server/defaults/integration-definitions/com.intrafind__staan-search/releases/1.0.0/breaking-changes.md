# Staan 1.0.0 — breaking changes

Config migration V203 replaced the `websearch` installation (`com.intrafind/web-search`, V195):

- `staan` is installed where a Staan key was configured: the credential the `websearch` installation referenced (it moves to `apiKeyRef`) or `STAAN_API_KEY`. It takes over the enabled state of `websearch`.
- An install without a Staan key gets no `staan` installation; install it from the catalog when you need it.
