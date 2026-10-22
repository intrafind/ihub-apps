# Features — Unreleased

- **The shipped `config.env` of the binary distribution is slimmed down.** It now lists only the process settings (`PORT`, `HOST`, `WORKERS`, HTTPS certificates, `NODE_EXTRA_CA_CERTS`, `CONTENTS_DIR`). The LLM and web-search API keys, search endpoint overrides and the never-supported `GOOGLE_SEARCH_*` entries are gone: add providers and keys in the setup wizard or under **Admin → Providers**, where they are stored encrypted. Existing installations keep their own `config.env`, and keys already set as environment variables keep working.
