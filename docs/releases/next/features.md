# Features — Unreleased

- **iHub now trusts the server's own certificate store.** A company CA that is installed on the machine (Linux CA store, Windows or macOS certificate store) is trusted for every outbound TLS connection, such as LLM endpoints, MCP servers and `wss://` voice transcription, in addition to Node's built-in roots. Nothing needs to be configured, and the Docker image, binaries and `npm start` all behave the same. Set `NODE_USE_SYSTEM_CA=0` to turn it off. This needs Node 24.5 or later; on older runtimes set `NODE_USE_SYSTEM_CA=1` or `NODE_EXTRA_CA_CERTS` instead.
