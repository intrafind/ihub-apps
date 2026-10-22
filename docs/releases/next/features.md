# Features — Unreleased

- **iHub now trusts the server's own certificate store.** A company CA that is installed on the machine (Linux CA store, Windows or macOS certificate store) is trusted for every outbound TLS connection, such as LLM endpoints, MCP servers and `wss://` voice transcription, in addition to Node's built-in roots. Nothing needs to be configured, and the Docker image, binaries and `npm start` all behave the same. Set `NODE_USE_SYSTEM_CA=0` to turn it off. This needs Node 24.5 or later; on older runtimes set `NODE_USE_SYSTEM_CA=1` or `NODE_EXTRA_CA_CERTS` instead.

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

## Projects for users (preview)

Users can keep their own **projects** (sidebar → Projects): a container with documents,
instructions and chats, private until shared. Chats started from a project, or moved into one,
answer with the project's instructions and documents. Switch it on with the `userProjects`
feature flag; the `projects` and `projectSharing` group permissions decide who may create and
share projects.

- Add documents by upload (several files at once, with the limits from `platform.projects`), from
  OneDrive / SharePoint, Google Drive or Nextcloud (the text is taken with the user's account and
  can be refreshed later), or as a web page, iHub page or iFinder document or search.
- Each document shows its status (waiting, extracting, ready, failed with the reason, outdated)
  and can be pinned, renamed, refreshed or removed; the page shows the usage against the quotas.
- Share with users, groups or everyone signed in as *user* (chat and read) or *editor* (also
  change documents, instructions and members); owners can transfer or delete a project. A project
  whose owner is no longer active stays readable but cannot be changed.
- The project page lists its chats (all, or only your own) and starts new ones in any app that
  allows projects. A stored chat moves into a project or out of it from the chat page or the chat
  history, and both show which project a chat belongs to.
- Answers name the project they drew on, and citations from a project show whether the document
  was uploaded or picked ("Picked from SharePoint · text taken 12 Oct 2026"); the preview shows the
  stored text with the cited passages highlighted, since originals are not kept.
