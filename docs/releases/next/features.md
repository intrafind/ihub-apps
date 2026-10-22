# Features — Unreleased

**The shipped `config.env` of the binary distribution is slimmed down.** 
It now lists only the process settings (`PORT`, `HOST`, `WORKERS`, HTTPS certificates, `NODE_EXTRA_CA_CERTS`, `CONTENTS_DIR`). 
The LLM and web-search API keys, search endpoint overrides and the never-supported `GOOGLE_SEARCH_*` entries are gone: 
add providers and keys in the setup wizard or under **Admin → Providers**, where they are stored encrypted. 
Existing installations keep their own `config.env`, and keys already set as environment variables keep working.

**iHub now trusts the server's own certificate store.**
A company CA that is installed on the machine (Linux CA store, Windows or macOS certificate store) is trusted for every outbound TLS connection,
such as LLM endpoints, MCP servers and `wss://` voice transcription, in addition to Node's built-in roots.
Nothing needs to be configured, and the Docker image, binaries and `npm start` all behave the same. Set `NODE_USE_SYSTEM_CA=0` to turn it off. 
This needs Node 24.5 or later; on older runtimes set `NODE_USE_SYSTEM_CA=1` or `NODE_EXTRA_CA_CERTS` instead.

## Admin Projects: knowledge for apps, workflows and agents

Admins manage knowledge as **projects** (Admin → Projects), the successor of sources. A project
holds documents and link items plus instructions, and is linked to apps, workflows, workflow
nodes and agent profiles with a mode: `context` puts its text into the prompt, `tools` leaves it
to the knowledge tools, `auto` loads it in full while it fits the budget and searches it
otherwise. The chat shows which happened.

- Upload PDF, Word, PowerPoint, Excel, OpenDocument, HTML, e-mail, Markdown, CSV, JSON, XML and
  text files; the text is extracted and stored encrypted (per-document keys wrapped by the
  installation's encryption key), the original is discarded. A scanned PDF without a text layer
  is reported, not stored empty.
- Link items keep the knowledge where it is: a web page, an iHub page, an iFinder document or
  search, fetched when used with the reading user's rights.
- The models reach projects through `knowledge_search`, `knowledge_read` and `knowledge_list`;
  every hit is an answer source with its provenance (uploaded, picked, linked, written).
- `platform.projects` sets the limits (files per project, file and project size), the sharing
  audiences for user projects, the load-all budget and an optional malware scan hook
  (`projects.scan`, `none` or a scanner command such as `clamdscan --no-summary --fdpass {path}`).
- `GET /api/admin/projects/_tokens` reports the size of each project for the app editor;
  `POST /api/admin/projects/:id/test` reads every item the way a chat would.
