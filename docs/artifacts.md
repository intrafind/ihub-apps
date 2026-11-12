# Artifacts

An **artifact** is content a run produced that is worth keeping in its own
right: the image a chat turn generated, the file a system skill tool generated
in it (a PDF from the [`pdf` skill](pdf-generation.md#generated-files), kind
`document`), and — as producers adopt the store — the report a workflow wrote
or the output an agent produced.

It is deliberately not a chat concept. A chat turn is one producer among
several, and "what did this produce" is the same question whether the thing
that produced it was a conversation, a workflow execution or an agent run. So
there is one store, addressed by a **scope**, and every producer writes through
it.

> **Status.** Chat turns are the first producer. The legacy agent artifact tree
> under `contents/data/agent-artifacts/` is a separate, older mechanism and has
> **not** moved yet — see [What has not moved yet](#what-has-not-moved-yet).

## The model

An artifact is **two things under one key**: a small metadata document and the
payload itself, in two different storage facets.

```js
// document — artifacts/<scopeType>__<scopeId>__<artifactId>
{
  version: 1,
  scope: { type: 'chat', id: '7f3c…' },   // what it belongs to
  kind: 'image',                          // what it is
  mimeType: 'image/png',
  bytes: 1483204,                         // of the payload, decoded
  sha256: '…',                            // integrity, recorded on write
  name: 'a cat.png',                      // when the producer gave one
  runId: 'run-…',                         // what made it
  createdAt: '2026-09-15T09:00:00.000Z'
}

// blob — artifacts/<scopeType>__<scopeId>__<artifactId>
//   the bytes, raw
```

On the filesystem provider that is
`contents/data/artifacts/<key>.json` for the metadata and
`contents/data/blobs/artifacts/<key>` for the payload.

**The payload is never inlined in the producer's own documents.** A chat
transcript and a workflow state document are single documents that their
producer re-reads, re-serializes and re-hashes on every step, and that ship
back whole when the thing is opened. One artifact inlined there is paid for on
every step for as long as the producer lives. The producer records a
descriptor instead — `{ id, kind, mimeType, bytes }` — and the payload is
fetched only when a viewer actually looks at it.

**And it is not in the artifact's own document either.** Metadata is small,
listable and filterable; a payload is megabytes written once and read whole.
Keeping them apart is what lets `list()` answer "what did this produce" without
touching a single byte of content — and it is what makes the payload store
swappable, which is the subject of [the next section](#swapping-the-payload-backend).

**No base64.** The bytes are stored raw. A producer may hand the store base64 —
that is how a model reports a generated image — but it is decoded at the
boundary, so the 33% encoding tax is paid once on the way in rather than on
disk and again on every read. `bytes` is therefore the real size of the
content, which is also what the caps are measured on.

**No locking.** An artifact is written once, read many times and never
modified, so there is nothing for two writers to lose — and a multi-megabyte
write never queues behind the producer's own lock.

## Swapping the payload backend

The payload goes through the storage provider's **blob facet**
(`provider.blobs`, the `BlobStore` contract) — the seam
[#2318](https://github.com/intrafind/ihub-apps/issues/2318) exists for. It is
deliberately the smallest surface every candidate backend already has:

| Operation | Filesystem        | S3-compatible   | PostgreSQL           |
| --------- | ----------------- | --------------- | -------------------- |
| `put`     | atomic file write | `PutObject`     | large object/`bytea` |
| `get`     | read file         | `GetObject`     | read                 |
| `delete`  | unlink            | `DeleteObject`  | delete               |
| `list`    | readdir + filter  | `ListObjectsV2` | `LIKE` on key        |

No transactions, no locking, no streaming semantics, no filesystem
assumptions. An S3 adapter implements those four calls, declares
`blobStore: true`, and **nothing in `ArtifactRepository` or above it changes** —
which is what takes uploads and artifacts off the shared-volume requirement
that pins a deployment to one machine today.

Two rules keep it that way, and the conformance suite enforces both:

- **The blob facet stores bytes, not meaning.** Media type, display name,
  producer and timestamps live in the metadata document. `put` accepts a
  `contentType` hint so an object store can set it on the object (an S3
  presigned URL needs it to serve correctly), but the document stays
  authoritative and a backend that cannot persist it simply ignores it.
- **Prefix listing is part of the contract.** It is how a scope is swept, and
  the only way to reach a payload whose metadata document never landed.

`server/storage/__tests__/providerConformance.js` runs the facet's contract
against any provider that declares the capability, so a future backend is
tested against the same expectations the filesystem one meets.

> `blobStore` is a different capability from `blobs`, which says the *append
> log* can park payloads beside a stream — the run ledger's spill files. The
> two are unrelated stores.

## Scopes

A scope is the thing whose lifetime the artifact follows. The set is closed,
because the scope type is part of a storage key and a typo in one producer
would otherwise create a scope nothing else can find or sweep.

| Scope  | Id             | Used by                                              |
| ------ | -------------- | ---------------------------------------------------- |
| `chat` | chat id        | a stored chat's turns; swept when the chat is deleted |
| `run`  | run/execution id | a workflow execution or an agent run                |

Every artifact of one scope shares a key prefix, which is what makes
"everything this chat produced" and "everything this run produced" the same
cheap prefix walk — and what lets the delete sweep find an artifact whose
descriptor never landed on a message.

A scope id that cannot be a storage key simply has no artifacts: a headless
agent chat is `agent:<runId>:<hex>`, and a colon is not a valid document key.
That is a no-op, never an error.

## Kinds

A kind says what an artifact is, and carries the media types it may be served
as. The type comes from whatever produced the artifact — a model response, a
tool — and ends up in a `Content-Type` header on a same-origin URL, so an
allowlist per kind is what keeps a producer from having the server hand a
browser something executable.

| Kind       | Media types                                                             |
| ---------- | ----------------------------------------------------------------------- |
| `image`    | `png`, `jpeg`, `webp`, `gif`, `avif`, `bmp`, `heic`, `heif`              |
| `document` | `text/markdown`, `text/plain`, `text/csv`, `application/json`, `application/pdf`, Word, PowerPoint, Excel |
| `code`     | Text files from `create_file`: `text/javascript`, `application/typescript`, `text/x-python`, `application/json`, `application/yaml`, `text/csv`, `text/markdown`, `application/sql`, `text/x-sh`, `text/css`, … (the list is `TEXT_FILE_TYPES` in `shared/generatedFiles.js`) |
| `archive`  | `application/zip` |

Anything else is stored and served as `application/octet-stream` with
`X-Content-Type-Options: nosniff`. Two absences are deliberate:
`image/svg+xml` is not an image here and `text/html` is not a document — both
are documents that can run script, and `nosniff` does not help when the type is
honest.

**Code is served as text.** A `code` artifact keeps its own type in the
metadata, but goes out as `text/plain; charset=utf-8` (Markdown, CSV and JSON
keep their own type, also labelled UTF-8), always with `nosniff`. Served under
its own type, a `.js` or `.css` artifact on a same-origin URL would be a script
or a stylesheet a page of this origin could load. A file named `.html` or
`.svg` is recorded as `text/plain` in the first place.

**Adding a kind** is an entry in `ARTIFACT_KINDS` (`artifactPolicy.js`) plus a
renderer on the client. Nothing in the storage path, the caps, the endpoints,
the listing or the delete cascade is kind-specific. A kind brings its own
allowlist and cannot widen another's.

## Configuration

`platform.json → artifacts`, read fresh on every write so an admin's change
takes effect without a restart:

| Key           | Default    | Meaning                                                      |
| ------------- | ---------- | ------------------------------------------------------------ |
| `enabled`     | `true`     | Master switch for every producer; `false` stores nothing      |
| `maxBytes`    | `10485760` | Largest single artifact, in bytes of content; `<= 0` uncapped |
| `maxPerBatch` | `8`        | Artifacts one producer records in one go; `<= 0` uncapped     |
| `maxZipFiles` | `200`      | Files in one ZIP archive (download or `create_zip`); `<= 0` uncapped |
| `maxZipBytes` | `104857600` | Content bytes in one ZIP archive, before compression; `<= 0` uncapped |
| `scriptHosts` | `["cdnjs.cloudflare.com", "cdn.jsdelivr.net", "unpkg.com"]` | CDN hosts an HTML artifact's preview may load scripts and stylesheets from; `[]` keeps the preview offline. See [HTML previews](#html-previews) |

Migration V106 seeds the block into existing installations at its defaults, so
an upgrade changes nothing on its own. Migration V190 adds the two ZIP limits
the same way. Migration V245 adds `scriptHosts` with the three default
CDNs, so after the upgrade HTML artifacts can load libraries from them; set
`[]` to keep the preview fully offline, as it was before.

The settings live here rather than under `chats` precisely because a workflow
reading its own limits must not have to reach into the chat settings to find
them.

## HTML previews

An HTML artifact (from the `web-artifacts` or `dashboard` system skill) is
model-written markup with script in it. The chat's Artifacts panel and the
[share embed page](chat-sharing.md) run it in
`<iframe sandbox="allow-scripts" srcdoc="…">` — an opaque origin with no
access to iHub, its cookies or storage — under a Content Security Policy built
in `shared/artifactPreview.js`:

| Allowed                                                        | Blocked                                                    |
| -------------------------------------------------------------- | ---------------------------------------------------------- |
| Inline `<script>` and `<style>`, `eval` / `new Function`        | `fetch`, XHR, WebSocket, form posts                        |
| Scripts and stylesheets over `https` from `artifacts.scriptHosts` | Every other host, and `http:`                              |
| `data:` / `blob:` images and media, `data:` fonts               | Remote images and fonts, CSS `url()` / `@import` elsewhere |

`scriptHosts` takes bare host names (`cdn.example.com`, or
`https://cdn.example.com`); a wildcard, path, port or `http:` entry is dropped.
An internal mirror of a public CDN works too: list its host. The names reach the
browser through `GET /api/configs/platform` (`artifacts.scriptHosts`), because
it builds the policy.

**Theme.** `prefers-color-scheme` inside the frame follows the operating
system, not iHub's own light/dark switch. The preview therefore sets
`data-theme="light|dark"` on the artifact's `<html>` before its markup is
parsed, and the skills style `:root[data-theme="dark"]` alongside the media
query. A file opened on its own falls back to the media query.

**Checks before the user sees it.** `create_web_artifact` returns warnings —
and the model fixes and resends the file — for URLs the preview will not load
(given this installation's `scriptHosts`), inline scripts that do not parse
(compiled with `vm.Script`, never run), and markup that was cut off mid-file
(an unclosed `<script>` or `<style>`, or no `</body>`/`</html>`), besides
relative files, dead links and unguarded storage.

Known limit: CSP does not govern navigation of the frame itself, so a script
can still navigate the frame to another address. The sandbox stops top-level
navigation, popups and any access to the parent.

## Authorization

The store has no opinion about who may read an artifact. A route authorizes the
**scope** — the chat, the run, the execution — exactly as it would to read
anything else about it, and only then asks for the bytes. An artifact id is
minted server-side and is never a capability on its own; a chat that is not
yours answers `404`, like every other chat endpoint.

A [share](chat-sharing.md) is the one other scope a route authorizes: it
serves the artifacts its frozen transcript named — an allow-list of ids
recorded when the share was created — out of the chat's scope, and nothing
else in that scope.

## API

Today the surface is the chat's, because chats are the only producer:

| Method & path                                  | Purpose                                              |
| ---------------------------------------------- | ---------------------------------------------------- |
| `GET /api/chats/:chatId/artifacts`             | What this chat produced, newest first, as descriptors |
| `GET /api/chats/:chatId/artifacts/:artifactId` | The bytes of one, as its own media type              |
| `GET /api/chats/:chatId/artifacts/:artifactId/provenance` | What the provider embedded in a generated image (its Content Credentials), from its [provenance record](provenance.md#images-provider-marks-3328); `404` when none was kept |
| `GET /api/shares/:shareId/artifacts`           | Through a [share](chat-sharing.md): the ones its snapshot named |
| `GET /api/shares/:shareId/artifacts/:artifactId` | The bytes of one of those; `?download=1` attaches    |
| `GET /api/shares/:shareId/artifacts/:artifactId/provenance` | The same provenance answer, through the share         |
| `POST /api/chats/:chatId/artifacts/zip`        | Several of the chat's artifacts as one ZIP           |
| `POST /api/shares/:shareId/artifacts/zip`      | Several of a share's artifacts as one ZIP            |

The ZIP routes take `{ "artifactIds": ["…", "…"] }`, or no body for every
artifact the caller may read (oldest first). They are authorized exactly like
the single-artifact route of the same scope; through a share, only the ids its
snapshot named can be packed, and any other id answers `404` like an unknown
one. Names keep their folders (`src/index.js`), paths are normalized so nothing
lands outside the archive, and a path used twice gets a ` (2)` suffix. An
artifact without a name is packed as `<kind>-<id>.<ext>`. The limits are checked
on the recorded sizes before a byte is read; over them the answer is `413` with
`code: "too-many-files"` or `"too-large"`. The response is
`Content-Disposition: attachment` and never cached.

The listing never carries payloads — it is the index, and the bytes are a
separate request per entry. It walks the artifact keys rather than the
transcript, so it also sees an artifact whose descriptor never landed on a
message.

The bytes response is `private, max-age=31536000, immutable`: an artifact
document is written once, never modified, and keyed by a fresh uuid, so what is
behind one URL cannot change. `private` because it is scope-scoped and a shared
cache holding it would serve one user's content to another.

A client fetches through its API client rather than pointing an `<img src>` at
the URL: the URL is credentialed, and a bearer token in `localStorage` only
travels on a request the client makes itself.

## The workspace pane

<!-- Older links: the Artifacts panel and the artifact viewer are this pane now. -->
<a id="the-artifacts-panel"></a><a id="the-artifact-viewer"></a>

A chat shows its files, generated and uploaded, and the sources its answers cite in one
**workspace pane** on the right of the chat. The pane is part of the chat page's layout, so
the chat reflows next to it and stays usable; the app's header keeps the full width above both: you can keep asking while a document is open.
(Design: `concepts/2026-11-10 Workspace Pane for Artifacts, Files and Sources.md`.)

### States and layout

| State | How you get there | Layout |
| --- | --- | --- |
| Closed | ✕, Esc with focus in the pane, Back | Chat at full width |
| Docked | A file card, a source's **Preview**, the header's **Files** button, Ctrl/Cmd+. | Next to the chat, which reflows |
| Full screen | ⤢ or Ctrl/Cmd+Shift+E | The pane fills the content area under the app header, text in a reading column, a composer dock at the bottom |

- **Width.** The docked pane opens at half the row, clamped to 420–960 px. Drag the divider
  (or focus it and use the arrow keys, Shift for bigger steps, Home/End for the limits) to
  resize it between 360 px and 70 %; the chat never gets narrower than 360 px. A double-click
  on the divider resets the width. The width is remembered in the browser (`localStorage`), as
  a convenience only.
- **Sidebar.** Below 1280 px, opening the pane folds the left sidebar to its icon rail, once
  per browser tab, and unfolds it when the pane closes. Expanding the sidebar by hand wins.
- **No split.** Below 1024 px, at high zoom, in the Outlook task pane, in the browser
  extension and in the admin app test panel, the pane opens as a full-screen sheet over the
  chat (a modal dialog with a focus trap) with **Back to chat**.
- **One element.** Docked and full screen are the same element: the viewer is not reloaded,
  and its scroll position and Preview/Code mode are kept.

### URL and history

What the pane shows is in the chat URL, so a reload or a copied link reopens it:
`?artifact=<id>` (a generated file), `?file=<id>` (an uploaded file), `?source=<id>` (a cited
source), `?files=<tab>` (the Files index) and `&view=full` (full screen). Opening the pane
adds one history entry, switching between items replaces it, and full screen adds one more:
**Back** steps out one level at a time (full screen → docked → closed). A file of an answer
that is still streaming has no id yet and is kept in memory, not in the URL.

### Files index and detail

The pane is a small list → detail stack:

- **Files index**, with the tabs **Generated** (`GET /api/chats/:chatId/artifacts`, newest
  first), **Uploaded** (the files of the chat, see [Chat files](chat-files.md)) and
  **Sources** (what the answers cite; only where the pane is docked). A row shows the size,
  date and the answer that produced it; **Answer 3** scrolls the chat to that answer and
  highlights it. A click opens the detail; the checkbox of a generated file selects it without
  opening it. **Download all (.zip)**, or select some and use the bar that appears
  ("2 selected · Download .zip · Clear"); the server builds the archive
  (`POST …/artifacts/zip`) and says so when it is over the [ZIP limits](#configuration).
- **Detail** of one item, always with a back link: **‹ Files**, or **‹ <file>** when a source
  was opened while a file was shown. The title is also a menu to switch to any other file of
  the chat.

A shared chat offers the same pane through the share's routes: it lists and packs only what
the snapshot named, read-only.

### The header

One header for every kind of item:

`[‹ Files] [name BADGE ▾]  …  [Preview | Code] [Copy | ▾] [⤓] [Share] [⤢] [✕] [⋯]`

- **Preview | Code** for Markdown, HTML, SVG, CSV/TSV and notebooks.
- **Copy** copies the text; its dropdown ("More copy and download options") holds **Copy as
  Markdown** and the exports (Markdown, HTML, PDF through `shared/utils/markdownExports.js`; an
  HTML artifact exports as its own file).
- **Download**, **Share** (a read-only link to the one file; see
  [Chat Sharing → Sharing a single file](chat-sharing.md#sharing-a-single-file)).
- **⋯**: open in new tab, show in Files, browser full screen, and for uploads Download text,
  Attach to email and Delete.
- Below a pane width of 480 px, Share and the Preview/Code switch move into ⋯ and Download
  into the Copy dropdown.
- A **source** shows **Passage 2/5 ↑↓** in place of versions, **Open in source system** in
  place of Share, and a small zoom control at the bottom right of the PDF.

### Previews

Pictures, Markdown (rendered and sanitized), JSON (pretty-printed) and every other `code`
artifact as highlighted text. PDFs open in an embedded viewer. HTML runs in a sandboxed frame,
SVG is sanitized and drawn, CSV/TSV is a table (first 200 rows) and a notebook shows its
cells. Word, PowerPoint, Excel and archives have no preview: download them. A text preview
reads at most 512 KB. The HTML preview never touches the server's `text/plain` serving
described under [Kinds](#kinds): the browser gets the text through the API client.

### Keep chatting

- **Ask about a passage.** Select text in the pane: a chip offers **Ask about**, **Edit with
  AI** and **Copy** (Ctrl/Cmd+Shift+K asks from the keyboard; on a touch screen a button
  "Ask about selection" appears). The passage goes above the composer as a quote with the file
  name, and is sent as a Markdown quote naming the file (and the artifact id) before your
  question. **Edit with AI** asks the assistant for the whole document again **as a new file**:
  the original is not changed. For HTML and SVG the chip works in the **Code** view only; the
  rendered preview is a sandboxed frame the page cannot read.
- **Full screen** keeps a floating composer dock at the bottom: one line, "Ask to change this
  document…", which expands to the composer with the latest answer and **Open chat** (back to
  the docked pane; on a sheet, back to the chat, with the file still on its card for one tap to
  reopen).
- The card of the file that is open in the pane is highlighted (`aria-current`).

### Keyboard and screen readers

- Docked and full screen are not modal: no focus trap. The pane is a region "Workspace: <name>"
  inside `<main>`, and **Skip to workspace** is a skip link while it is open.
- Opening the pane by a click moves focus to its heading; closing returns focus to what opened
  it (or to the composer).
- **F6 / Shift+F6** cycle sidebar → chat messages → composer → pane. **Ctrl/Cmd+.** opens and
  closes the pane.
- **Esc** closes the innermost layer only — a menu, the selection chip, the composer dock, full
  screen, then the pane — and only while focus is in the pane. Esc in the composer never closes
  the pane.
- One polite live region per pane announces copies, the width while resizing ("Workspace 55
  percent"), a folded sidebar and a quoted passage. Streamed answer text is never put into it.

### Pages without a chat

**Open in new tab** opens `/artifacts/:chatId/:artifactId` (`ArtifactPage`, owner only; the
route is in `KNOWN_ROUTES` and `client/index.html`): the same viewer as a whole page, without
close or expand. A single-file share (`/share/:shareId`) renders the same way; `?embed=1`
hides the header.

### Security

HTML stays in `<iframe sandbox="allow-scripts">` under the preview CSP (`HTML_PREVIEW_CSP`), in
the pane and on the standalone pages; being inline next to the chat never makes it
same-origin. A `blob:` URL of an HTML artifact is never navigated to. Browser full screen is
requested on the viewer's container, never inside the frame, so the frame has no
`allow-same-origin`, `allow-popups` or `allow="fullscreen"`.

### Not included yet

Versions of an artifact, revising it in place, a diff between versions, share links pinned to
a version, Office previews and an admin setting to turn the pane or its auto-open off. These
are Phase 2 of the concept.

Code: `client/src/features/workspace/` (pane, divider, header, selection chip, composer dock,
`utils/workspaceState.js`), `client/src/features/chat/components/ArtifactViewerHost.jsx` (state,
URL, keyboard), `ArtifactViewer.jsx`, `ArtifactsPanel.jsx` (the Files index),
`UploadedFilesTab.jsx` (an uploaded file), `ArtifactPreview.jsx`, `ArtifactShareDialog.jsx`,
`contexts/ArtifactViewerContext.jsx`, `pages/ArtifactPage.jsx`, `SharedArtifactView.jsx`,
`client/src/features/chat/utils/artifactFiles.js`.

## Lifetime

An artifact goes when its scope goes, and when whatever named it goes:

- **Scope deleted** — `deleteScope()` empties it by key prefix, so a payload
  whose descriptor never landed is collected too. The chat delete cascade calls
  this.
- **Reference dropped** — a chat edit that rewrites history from a message, or
  the per-chat message cap pushing a message out, deletes the artifacts those
  messages named.

There is no age-based sweep of the namespace itself; artifacts are reclaimed
through their scope.

## Reading a chat's artifacts in a later turn

The transcript keeps only an artifact's descriptor, so its content never goes back to the model
with the history. In a later turn of the chat, the model lists the created files with
`chat_artifacts_list` and reads one with `chat_artifacts_read`: the text of code and text files,
or the extracted text of a PDF, Word, PowerPoint or Excel file. Both find the same files as
`create_zip`: the stored artifacts and the files still held from the current turn
(`chatArtifactCandidates` in `services/documents/files/fileTools.js`). See
[What earlier turns give the model](chat-persistence.md#what-earlier-turns-give-the-model).

## Using it from a new producer

```js
import { getArtifactRepository } from '../artifacts/ArtifactRepository.js';

const descriptor = await getArtifactRepository().put(
  { type: 'run', id: executionId },
  { kind: 'document', mimeType: 'text/markdown', data: base64, name: 'report.md', runId }
);
// Record `descriptor` wherever the producer records its own output, and
// call `deleteScope({ type: 'run', id: executionId })` when that output goes.
```

Three things a producer owes the store: record the descriptor somewhere it can
find again, empty the scope when the scope's own data is deleted, and expose a
route that authorizes the scope before serving the bytes.

## What has not moved yet

The agent artifact tree — `contents/data/agent-artifacts/<runId>/<name>`,
written by `server/agents/runtime/artifactStore.js` and the `write_artifact`
tool, read by `GET /api/agents/runs/:runId/artifacts` — predates this store and
still runs on its own. It is not a drop-in swap:

- it stores **text only** (`writeArtifactDirect` requires a string), while this
  store is base64 and binary-capable;
- its read route **hardcodes `text/markdown`**, so the `contentType` it records
  is already inaccurate for anything else;
- its quotas are per run and counted against in-state bookkeeping, not against
  what is on disk;
- it has **no retention at all**, and the workflow-state sweep deletes the
  state its authorization check depends on — leaving files that are unreadable
  by their owner and never collected.

Moving it is a data migration plus changes to the admin UI, the SSE projection
and the `write_artifact` tool, and is worth doing on its own rather than inside
a bug fix. The store above is shaped to receive it: `run` is already a scope,
and `document` is already a kind.

Workflow outputs are the other obvious producer. Today a workflow's real
deliverable — the Markdown/PDF/DOCX a user downloads from the execution page —
is generated **in the browser** and never persisted; the `template-render` node
is the only one that writes a file, and it writes into the agent tree.

## Code map

| File                                                | Responsibility                                         |
| --------------------------------------------------- | ------------------------------------------------------ |
| `server/storage/BlobStore.js`                       | The payload contract an S3 or database backend implements |
| `server/storage/providers/filesystem/FilesystemBlobStore.js` | It, on files                                  |
| `server/services/artifacts/ArtifactRepository.js`   | The store: scopes, keys, put/get/list/delete            |
| `server/services/artifacts/artifactPolicy.js`       | Kinds, media-type allowlists, caps and the master switch |
| `server/services/chat/chatMaterializer.js`          | The chat producer: a turn's images become artifacts     |
| `server/routes/chats.js`                            | The chat-scoped endpoints                               |
| `client/src/features/chat/components/GeneratedImage.jsx` | Renders a live, a stored or an unavailable image   |

```bash
node --test server/tests/artifact-repository.test.js
npm run test:storage   # includes the blob facet's conformance tests
```

See also [Chat Persistence](chat-persistence.md) and
[Storage Providers](storage.md).
