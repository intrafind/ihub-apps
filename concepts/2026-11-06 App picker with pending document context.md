# App picker with pending document context

Issue: intrafind/ihub-apps#3336 · iFinder side: APPS-1655 ("Open in iHub" hit action), spike APPS-1656

## Problem

iFinder wants an "Open in iHub" action on a hit: the user lands in iHub, chooses an app, and the
document is attached to that app's chat. Today `documentId` + `source` (+ `searchProfile`) are only
understood on `/apps/:appId` (`AppChat.jsx`), so the host must already know the target app, and the
`/apps` list and `/start` drop the context.

The first iteration of this PR carried the context through the picker but kept two things that do
not fit the integrations platform:

- the link names a **source provider** (`source=ifinder`), an older concept, instead of the
  integration the document comes from;
- the picker offered **apps with file upload**, which says nothing about whether an app may receive
  a document of *this* system, and the attach always ran the document text extraction, so an image
  from iFinder was never attached as an image.

## Decisions

### 1. The link names the integration

```
/apps?documentId=<id>&integration=<installation id>[&searchProfile=<id>][&prefill=…]
```

`integration` is the id of an installed integration (`ifinder`). `source` is gone — a clean break,
nobody links with it yet. The same parameters work on `/apps/:appId` (the app is then known) and
`/start` (hands over to `/apps`). `documentId` and `searchProfile` keep their names; for the
integration they are the `ref` (`{ id, scope }`) of the document.

### 2. The document is a capability of the installed integration

A definition that can hand over a document by reference declares the capability **`files`** (the
capability the storage providers Office 365, Google Drive and Nextcloud already declare). A native
connector implements it:

```js
files: {
  /** Is the installation usable (configured)? Optional; an installation with enabled:false never is. */
  configured(instance) → boolean,
  /** One document's bytes: { contentType, stream | body, contentDisposition?, fileName? }. format: original | pdf | text */
  content({ ref, user, format }),
  /** Its details. Optional. */
  metadata({ ref, user })
}
```

The contract stays small on purpose: *by reference*. Browsing (`roots`, `list`) is the rest of the
planned storage contract (`2026-10-20 Unified Integrations/2026-11-01 Storage provider contract.md`)
and is not needed to open one document; a provider that adds it later keeps these two methods.

iFinder (`com.intrafind/ifinder`, 1.2.0) declares `files` and implements it by moving what the
`ifinder` source provider did into its connector. The source provider stays registered as a thin
adapter over the connector, because the answer-sources panel and project link items call it in the
server; it holds no logic of its own.

### 3. One gate, on both HTTP routes

New, in the style of the Nextcloud routes:

| Route | Purpose |
| --- | --- |
| `GET /api/integrations/:id/files` | the probe: `{ id, definition, type, name }` of an installation that can hand over documents and that this user may use |
| `GET /api/integrations/:id/files/content?id=&scope=&format=` | the document, streamed with its headers |
| `GET /api/integrations/:id/files/metadata?id=&scope=` | its details |

`:id` is checked against the installations before anything runs (no path building from input):

| Case | Answer |
| --- | --- |
| no such installation, or its definition has no `files` capability | `404 INTEGRATION_NOT_FOUND` |
| installation disabled, or the connector says it is not configured | `404 INTEGRATION_NOT_CONFIGURED` |
| the user's groups do not grant it (`permissions.integrations`, `mayUseIntegration`) | `403 INTEGRATION_NOT_GRANTED` |

The existing `GET /api/sources/:provider/content|metadata` (preview, download, Outlook attach)
resolves a provider id through the same function, so a provider that is an installation gets the
same gate and the same implementation; `project` and providers registered by code are passed
through as before (the project provider enforces membership itself). The files routes resolve ids
the same way, so "Open in App" for a project document or a third party's provider keeps working:
its `integration` value is the provider id the source carries, the probe answers
`{ id, definition: null, type: null, name: id }` for a provider that is not an installation, and no
integration gate applies beyond the provider's own rules.

### 4. Attach like Nextcloud: original file, images included

The chat attaches through the helper the Nextcloud embed and the cloud pickers use:

1. fetch the **original** (`format=original`) through the integration route;
2. check the app's upload config as `useNextcloudEmbedAttachments` does (uploads on, supported
   formats, image vs document);
3. `processCloudFile(file, uploadConfig)`: an image becomes an image attachment (resized base64, for
   a vision model), audio an audio attachment, everything else a document that keeps its original
   (`[ORIGINAL_FILE]`) next to the extracted text.

The text is fetched, as a `.txt`, only when the request for the original fails with an error other
than a sign-in, permission or not-found failure (a document of which only the text is kept, as the
downloads do); a permission failure applies to the text as well and is shown. The supported-format
check of the app does not apply to that text.

### 5. The picker offers the apps that can take this document

The picker asks the probe first and shows the document (title and type from `metadata`):

| State | Trigger | UI |
| --- | --- | --- |
| checking | probe / metadata in flight | neutral banner |
| ready | probe 200 | "Choose an app to open **{title}** in" |
| unavailable | probe 404 / 403 | error: the integration is not available to you; apps open without the document |
| no access | metadata 401/403 | error banner |
| not found | metadata 404 | error banner |
| unverified | no metadata route, 5xx, network | behaves as *ready* |

An app is eligible when it is a chat app that **binds the integration** (`app.integrations` key =
the installation id, its definition id, or `type:<type>`) **and** can take the document: its upload
settings accept the kind (image upload for an image, file upload otherwise; the kind comes from the
document's details). So an app that never opted into iFinder never receives an iFinder document,
and a bound app that cannot take the file is not offered. The model's own abilities (vision) are
checked when the chat attaches, where the model is known. The request still carries `documentIds`
(the iAssistant's retrieval scope); apps that use that path without upload are part of §6. The
checkbox in the banner ("Only apps that can use this document") is on by default and left out when
no app qualifies.

### 6. Reading the document with tools instead of attaching it

A binding with `actions: ["getContent", "getMetadata"]` gives an app iFinder without search; the
mechanism exists today. Having the *model* read the document by id (instead of an attachment) needs
a hint in the prompt and is **not** part of this change; it is the follow-up that lets
document-reading apps without upload become eligible.

## Not changed

- Embed mode: `AppChat` ignores URL params when embedded and embedded hosts do not render the list.
- `/` (the admin-configured home redirect) does not forward the parameters.
- `prefill` keeps its dual role (prompt text, file-name fallback).
- No config migration: the new definition version moves installations without one (as 1.1.0 did).

## Tests

- Server (`server/tests/integration-files-route.test.js`): the gate (404 not found, 404 not
  configured, 403 not granted, 200), the probe, content headers and streaming, format and id
  validation, status mapping, the sources route applying the gate to `ifinder`, a provider that is
  not an installation passing through.
- Client (`tests/unit/client/pending-document.test.jsx`): the helper (`integration` validation, the
  retired `source`, forwarding, binding match, kind, eligibility), the check hook's states, the
  picker (filter, forwarding, error states, dismiss), the attach hook (original image as an image,
  document label, upload settings, error messages, text fallback, ready gate, attached once), and
  `/start`.
