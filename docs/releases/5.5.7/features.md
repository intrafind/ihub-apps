# Features — 5.5.7

## Artifacts: What a Run Produced, Kept

A picture the model drew used to exist only in the tab that asked for it. The browser could not
hold it — a generated image is megabytes and `sessionStorage` is not — so the payload was dropped
on the way out and the chat came back with the answer and an empty space where the image had been.
With **Durable Chats** switched on, it is now kept and is there when the chat is reopened, on any
device.

It is kept as an **artifact**: content a run produced that is worth keeping in its own right. A
chat turn is the first producer, not the only conceivable one — a workflow's report and an agent's
output are the same kind of thing — so there is one store for all of them, addressed by the scope
that owns the content rather than by a chat id.

- **Stored beside the producer, never inside it.** Each artifact is its own document and is fetched
  only when somebody looks at it, so opening a chat that produced a dozen of them is still as fast
  as opening any other. Two new endpoints: `GET /api/chats/:chatId/artifacts` lists what a
  conversation produced (descriptors only, newest first) and
  `GET /api/chats/:chatId/artifacts/:artifactId` serves one. Both answer `404` to anyone but the
  owner, like every other chat endpoint.
- **A new `platform.json → artifacts` block**, added to existing installations by a migration:
  `enabled` (`true`), `maxBytes` (`10485760`, base64 bytes of a single artifact) and `maxPerBatch`
  (`8`, how many one answer records). Set `enabled` to `false` to keep transcripts without them; a
  cap of zero or less removes that cap. An artifact a cap turns away is still recorded, saying why
  it is not available, rather than disappearing without trace.
- **Media types are allowlisted per kind** — images and documents each bring their own list, and
  anything else is served as an opaque download. SVG and HTML are deliberately excluded: they are
  documents that can run script, not content.
- **Payloads go through a new blob facet on the storage provider**, as raw bytes rather than base64
  inside a document. The filesystem provider writes them under `contents/data/blobs/`. This is the
  seam a future S3-compatible or database-backed store plugs into — four calls, no filesystem
  assumptions — so artifacts will not be what pins a deployment to a single shared volume.
- **Nothing changes where chats are not stored.** Anonymous visitors, incognito turns, the compare
  panels and the canvas keep the old behaviour, and keep the note under each image telling the user
  to download it. That note is gone in a durable chat, where it is no longer true.

The existing agent artifacts under `contents/data/agent-artifacts/` are a separate, older mechanism
and are unchanged by this release.

See [Artifacts](../../artifacts.md) and [Chat Persistence](../../chat-persistence.md).
