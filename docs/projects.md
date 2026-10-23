# Projects

A **project** is one container for knowledge: documents, instructions and, for user projects,
chats. Apps, workflows and agents read a project's documents either in full, as part of the
prompt, or through three search tools. Answers cite the documents they drew on.

Projects come in two kinds behind one model:

|                     | Admin projects                                                    | User projects                                                    |
| ------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| Created by          | Content admins, under **Admin → Projects**                        | Users, under **Projects** in the sidebar                         |
| Used by             | Everyone who may use an app, workflow or agent that links them    | The owner and the members it is shared with                      |
| Stored as           | Configuration, `contents/projects/<id>.json`                      | Runtime data in the storage provider                             |
| Id                  | Chosen by the admin (`faq`, at most 50 characters, not `prj_…`)   | Minted, `prj_` followed by 22 characters                         |
| Name, description   | Localized (`{ "en": "…", "de": "…" }`)                            | Plain text                                                       |
| Chats               | None                                                              | Chats started in the project, or moved into it                   |
| Feature flag        | `projects` (on by default)                                        | `projects` and `userProjects` (preview, off by default)          |

Admin projects are the successor of sources. An upgrade turns every source into an admin project
(see [Migration from sources](#migration-from-sources)).

## Documents

Each document in a project is an **item**. An item either holds text that iHub extracted and
stores, or links to content that is fetched when it is used.

### Item kinds

| Kind                | What it adds                                         | Stored as           | Read with the rights of                         | Offered when                                     |
| ------------------- | ---------------------------------------------------- | ------------------- | ----------------------------------------------- | ------------------------------------------------ |
| `upload`            | An uploaded file, or text written in the dialog      | Extracted text      | —                                               | Project file storage is available                |
| `url`               | A web page                                           | Link, cached 2 h    | —                                               | Always                                           |
| `page`              | An iHub page (`contents/pages`) in one language      | Link                | The reading user (the page's own access rules)  | Always                                           |
| `ifinder-document`  | One iFinder document                                 | Link                | The reading user                                | iFinder is configured                            |
| `ifinder-query`     | The hits of an iFinder search                        | Link                | The reading user                                | iFinder is configured                            |
| `office365`         | A file picked from OneDrive or SharePoint            | Text, taken at pick | The user who picked it (and refreshes it later) | A cloud storage provider of that type is enabled |
| `google-drive`      | A file picked from Google Drive                      | Text, taken at pick | The user who picked it                          | As above                                         |
| `nextcloud`         | A file picked from Nextcloud                         | Text, taken at pick | The user who picked it                          | As above                                         |

- An `ifinder-query` item with an empty query is a dynamic search: the model's search terms become
  the iFinder query. Such an item only takes part in `knowledge_search`; it is never loaded in
  full.
- Picked cloud files are snapshots. The text is taken with the picking user's account; the
  citation says when ("text taken 12 Oct 2026"). An editor with a connected account refreshes the
  item to take the text again.
- An iFinder document the reading user may not open is left out of that user's answer and named
  as unavailable; the item itself is not changed, because another member may still have access.
- `platform.projects.kinds` switches kinds off by id, for example `{ "url": false }`.

In the admin **Add item** dialog the three cloud tabs are disabled ("coming in a later release");
users pick cloud files from their own projects.

### Uploads

Uploads accept PDF, Word (`.docx`), PowerPoint (`.pptx`), Excel (`.xlsx`), OpenDocument (`.odt`,
`.ods`, `.odp`), HTML, e-mail (`.eml` and Outlook `.msg`), Markdown, CSV, JSON, XML and other text
files. Images, audio, video, archives, executables and the legacy Office formats (`.doc`, `.xls`,
`.ppt`) are refused; save those as `.docx`, `.xlsx`, `.pptx` or PDF first. An e-mail is stored as
its headers (subject, sender, recipients, date), the names of its attachments and its body; the
attachments themselves are not read. Each file is one request, so several files
upload in parallel and each gets its own status.

The server extracts the text, encrypts it and stores it. **The original file is discarded.** A
PDF of at most 500 pages is read; extracted text longer than 10,000,000 characters (about 10 MB,
2.5 million tokens) is cut at that length. A file that iHub imports from the server itself, such as
the shipped documentation, is not cut below 20,000,000. There is no OCR: a scanned PDF without a text layer fails with a message that says so.
Run it through OCR and upload the result.

A large text costs memory and time. The first search after a start, or after any document of the
project changed, builds the search index of the project: about 1.5 seconds per 10,000,000
characters, during which that worker does nothing else. A 10 MB text needs about 130 MB of heap
while it is searched (its index, the decrypted text and, for `knowledge_read`, a second index of
that one document). The indexes are kept for at most 30,000,000 characters per worker; past that
the oldest are dropped and built again when needed. A search of an unchanged project with a warm
index does not decrypt its texts again. Plan for a few such documents per project, not for the
largest allowed.

### Writing and editing text

The **Text** tab of the **Add item** dialog stores typed or pasted text as a document without an
upload, as the sources editor did. **Preview text** on an uploaded, written or migrated document
offers **Edit text**: the whole text opens in a text area, and saving replaces the stored document
(`PUT …/items/:itemId/text`). The item then counts as written by the editor, and the model reads
the new text from the next question on. A web page, an iHub page and a document picked from a
cloud drive or iFinder cannot be edited: their text is the source's and is fetched or refreshed
from there.

The limits of `platform.projects.limits` apply to admin and user projects alike: files per
project, bytes per file and bytes per project.

### Statuses

| Shown as         | Status       | Meaning                                                                                         |
| ---------------- | ------------ | ----------------------------------------------------------------------------------------------- |
| **Waiting**      | `pending`    | The item exists, the content has not arrived yet.                                               |
| **Extracting**   | `extracting` | The server is extracting and encrypting the text. The page refreshes until it is done.          |
| **Ready**        | `ready`      | Usable. Text items show their size in tokens, picked items the date the text was taken.         |
| **Failed**       | `failed`     | Permanent, with the reason. An upload has to be removed and added again; a picked cloud document can be refreshed once its source is reachable again. |
| **Outdated**     | `stale`      | A refresh could not read the source; the old text stays usable. A refresh that finds a newer version installs it and the item is **Ready** again. |

Link items are **Ready** as soon as their reference checks out.

The reasons a **Failed** item names:

| Code                | Message                                                                     |
| ------------------- | --------------------------------------------------------------------------- |
| `NO_TEXT`           | This PDF has no text layer (scanned). Run it through OCR and upload the result. |
| `UNSUPPORTED_TYPE`  | This file type is not supported.                                            |
| `EXTRACTION_FAILED` | The extractor's own message.                                                |
| `SCAN_REJECTED`     | Rejected by the malware scanner.                                            |
| `INTERRUPTED`       | The upload was interrupted. Upload the file again.                          |
| `SOURCE_FORBIDDEN`  | Connect the integration again; the document could not be read with your account. |
| `SOURCE_GONE`       | The source document was removed.                                            |

An item that stays **Waiting** or **Extracting** longer than `platform.projects.ingest.staleAfterMinutes`
(30 minutes, for example after a restart) is marked `INTERRUPTED`. The check runs at startup and
every 15 minutes.

## Admin projects

### Managing admin projects

**Admin → Projects** lists every admin project with its items, status and links, and the number
of user projects on the installation. The page needs the `projects` feature flag and the admin page
switch `admin.pages.projects`; content admins and full admins may use it.

1. Create a project with an id, name, optional description and **instructions**, category and tags.
2. Open it and add items with **Add item**: upload a file, paste text, or add a web page, an iHub
   page, an iFinder document or an iFinder search.
3. Pin items that must always reach the model (see [Load in full or search](#load-in-full-or-search)).
   Preview the stored text, edit the text of an uploaded, written or migrated document, rename,
   refresh or remove an item from the items table.
4. Link the project to apps, workflows and agents.

A disabled project is skipped by everything that links it. A project that something still links
cannot be deleted: the dialog lists the apps, workflows and agents to change first.

### Moving, copying and merging

Projects that belong together are often split: the sources migration made one project per source,
so a website that was five sources is five projects with one item each. Two tools bring them
together.

**Move or copy items.** Tick items in a project's items table and choose **Move to…** or
**Copy to…**, or use **Move or copy to…** in a row's menu. Pick the target project and confirm.

- A move leaves the source and arrives in the target; a copy leaves the source as it is.
- Stored text is encrypted per project and item, so the text is decrypted and encrypted again under
  the target with a new key. The kind, reference, pin, status and the original file's details come
  along, and the item records where it came from (`provenance.transferredFrom`).
- Items go one at a time. One that is still **Waiting** or **Extracting**, or **Failed**, cannot go
  yet (`ITEM_NOT_READY`); one that would exceed the target's limits is refused (`QUOTA_*`). The
  dialog lists these and the other items still go.
- An item that is changed while it moves (a refresh, an edit, a rename) stays where it is and is
  reported (`PROJECT_MISMATCH`); move it again.
- A moved item keeps its id unless the target already has an item with that id.
- Items move between admin projects only, not into or out of a user project.
- A copy of the shipped documentation is an independent document; a moved one keeps syncing with
  the shipped file.

**Merge projects.** Select two or more projects on the list and choose **Merge…**. Choose the
project that stays; the dialog shows how many items move and how many apps, workflows and agents
link the other projects.

1. Every item of the other projects moves into the kept project.
2. Apps, workflows (steps, loop bodies and planner task templates included) and agents that linked
   a merged project link the kept project instead. When one list linked several of them, it keeps
   one link, at the position of the first. The link's mode is the one they shared, or `auto` when
   they differed, and it may write when any of them could.
3. With **Delete the emptied projects** (on by default), the merged projects are deleted.

A project that ships with iHub (the `faq`, `meeting-knowledge-base` and `intrafind-website`
project, for example) is restored at the next server start once it is deleted, like any missing
default file. The merge result says so for such a project; disable it then, or leave **Delete the
emptied projects** off and disable it yourself.

A project whose items did not all move (an item still being processed, a limit) is left alone:
it keeps its remaining items and its links, nothing is deleted, and the result says why. Run the
merge again when the cause is gone. The **instructions** of a merged project are not carried over;
the dialog warns when one has any. Each merged and changed project has an entry in its change
history, and the links that changed are in the audit log summary.

The edit page warns while uploads are enabled and no malware scanner is configured
(`platform.projects.scan`).

### Linking a project

Apps, workflows, workflow steps (prompt, planner, verifier), planner task templates and agent
profiles carry a `projects` list. An entry is a project id, or an object with the access mode and
the write flag:

```json
{
  "projects": [
    { "id": "faq", "mode": "context" },
    { "id": "ihub-documentation", "mode": "tools" },
    "handbook"
  ]
}
```

| Field   | Values                          | Default | Meaning                                                                                                |
| ------- | ------------------------------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `id`    | A project id                    | —       | The project to link. A bare string is the same as `{ "id": "…", "mode": "auto" }`.                     |
| `mode`  | `auto`, `context`, `tools`      | `auto`  | `context` always puts the text into the prompt; `tools` leaves it to the knowledge tools; `auto` loads it in full while it fits the budget and searches it otherwise. |
| `write` | `true`, `false`                 | `false` | Whether a workflow or agent run may store documents in this admin project (`project-write`).           |

The app editor (**Admin → Apps**, card **Projects**), the workflow editor and the agent editor offer
a project picker with the mode and the project's size against the budgets. `write` is not
editable in the forms yet; set it in the JSON. A step's own `config.projects` replaces the
workflow's list for that step.

The linked project's **instructions** are added to the system prompt of the app, step or agent:
each project's instructions go in a `<project-instructions project="…">` block at the end of
the system prompt, whatever the link mode. They apply for the projects an app, workflow
or agent links and for the project a chat runs in; a project a user attaches to a single chat
brings its documents but not its instructions. Use them for how the knowledge is to be used ("answer
only from these contracts", "cite the clause number"), not for facts: facts belong in a document.
The project's **description** is shown to the model next to its name, so it can tell what a project
that is only searched can answer.

### The `{{projects}}` placeholder

The text of the linked projects goes into the system prompt as a `<projects>` block. Put
`{{projects}}` where it should go; without the placeholder the block is appended at the end of the
system prompt.

```xml
<projects>
  <project id="faq" name="FAQ" mode="loaded">
    <document id="itm_…" name="faq.md" origin="uploaded">…text…</document>
  </project>
  <project id="ihub-documentation" name="iHub Documentation" mode="searched" documents="1" tool="knowledge_search"/>
</projects>
```

### Switching user projects off for an app

`features.userProjects` on an app (default `true`) decides whether chats in this app may run inside
a user project. An app that answers from a fixed knowledge set turns it off:

```json
{ "features": { "userProjects": false } }
```

The app's own admin project links keep working. The project page offers only apps that allow
projects for **New chat**.

### Checking a project

- **Test** (`POST /api/admin/projects/:id/test`) reads every item the way a chat would, with your
  own credentials for iFinder items, and reports per item whether it was readable, its size and
  how long it took.
- **Estimate tokens** (`POST /api/admin/projects/:id/estimate`, on the project's view and edit
  pages) loads every item, link items included, and counts its tokens. It recommends for each
  document whether it is small enough to pin into the prompt (up to 20 % of the load-all budget)
  or better searched, and for the project whether it belongs in the prompt (it fits the budget;
  *tight* above half of it) or is searched (it exceeds the budget, or a source delivered only part
  of its text). It also names the context window a model needs to load the project in full. The
  numbers are an estimate; the real decision of a request is made against the model in use.
  User projects have the same button on their page (`POST /api/projects/:projectId/estimate`).
- The name of a project on **Admin → Projects** opens its read-only view; **Edit** leads to the
  form (`/admin/projects/:id/edit`).
- `GET /api/admin/projects/_tokens` reports each admin project's size in tokens, items and bytes,
  together with the load-all budget (`loadAllBudgetTokens`) and the tool result budget. The app
  editor uses it to explain whether a linked project will be loaded in full.

## How the model reaches a project

### Load in full or search

For every request the server plans each project in scope, in this order: the chat's own project,
the app's links, projects attached to the chat, the workflow's links.

- The **budget** is `min(platform.projects.loadAllMaxTokens, 40 % of the model's context window)`,
  50,000 tokens by default. Projects spend it in that order.
- `context`: every usable document goes into the prompt.
- `tools`: only pinned documents go into the prompt; the model searches the rest.
- `auto`: the whole project goes into the prompt when it fits what is left of the budget;
  otherwise only its pinned documents, and the model searches the rest.
- **Pinned** documents always go into the prompt, in every mode, ahead of the other documents of
  their project, even when they exceed the budget.
- Nothing injected may exceed **75 % of the model's context window**, whatever the mode. Documents
  beyond that limit are cut from the prompt and stay reachable through `knowledge_read`. The limit
  is spent project by project, in the order of the links: a pinned document of a later project is
  cut when the projects before it have used the limit up. Link the project whose pinned documents
  must always be present first.

Usable documents are those that are **Ready**, and **Outdated** ones whose old text is still
readable. Documents that are waiting, failed or unreadable for this user are listed as unavailable,
so the model can say so.

The budget depends on the model's `contextWindow` (see [Models](models.md)).

### The knowledge tools

Every request that reaches a project gets three tools automatically. They are not listed in an
app's `tools` array; the tool definition lives in `contents/tools/knowledge.json`, where an admin
can localize or disable it.

| Tool               | What it does                                                                                               |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `knowledge_search` | Searches the projects (all, or one with `project`) for passages that answer a query; ranked, numbered hits. |
| `knowledge_read`   | Reads one document in full, or one section of it. A long document comes back as an outline first.           |
| `knowledge_list`   | Lists the documents of the projects with id, name, kind, size, status and provenance.                     |

Each tool's description names the projects in scope and whether each one is loaded in full, so
the model knows which ids it may pass. A tool call can never reach a project the request did not
bring. Search is keyword search (BM25) over the stored text; there are no embeddings.

#### How much of a linked document is searchable

Link items are fetched when they are used, and the fetch is cut at a fixed length before anything
searches, reads or loads the text: per document, and for an iFinder search per hit. This limit is
separate from the tool result budget, which only shortens what one tool call returns from text
iHub already has:

| Kind                                | Default           | Option in `ref`    | Maximum   |
| ----------------------------------- | ----------------- | ------------------ | --------- |
| `ifinder-document`, `ifinder-query` | 10,000 characters | `maxLength`        | 1,000,000 |
| `url`                               | 50,000 characters | `maxContentLength` | 5,000,000 |

Only that first part of the document is searchable: neither `knowledge_search` nor another section
read with `knowledge_read` reaches the rest. iHub pages and uploaded or picked documents are not
cut this way. A cut document is marked as truncated in the tool result and in the prompt, and a
project with such a document counts as _searched_, not _loaded in full_, in the tool descriptions
and on the badge.

Set a higher limit when you add the item through the API (`POST /api/projects/:projectId/items` or
`POST /api/admin/projects/:id/items`), for example
`{ "kind": "ifinder-document", "ref": { "documentId": "…", "maxLength": 100000 } }`. The project
pages add items with the default, and an item's `ref` cannot be changed afterwards: remove the item
and add it again. Sources migrated from `config/sources.json` keep their `maxLength` and
`maxContentLength`.

### What users see

- A badge on the answer says which projects it used and how: _3 projects · 2 loaded in full · 1
  searched_. With one project it names the project and links to it when it is a user project;
  a project the viewer may not see reads _Private project_.
- Every search hit and every read document is an answer source in the **Sources** panel (see
  [Answer Sources](answer-sources.md)). The card shows the provenance: _Uploaded_, _Picked from
  SharePoint · text taken 12 Oct 2026_ or _Linked_. A document written by a workflow shows as
  _Uploaded_.
- The preview of an uploaded or picked document shows the stored text with the cited passages
  highlighted, because the original is not kept. **Download** saves the text as a `.txt` file.
- Project sources are found with the viewer's membership, so a shared chat leaves them out. The
  answer text keeps its citations.

## User projects

User projects are a preview feature.

### Switching user projects on

1. Turn on the feature flag `userProjects` (**Admin → Features**). The `projects` flag must be on
   as well; it is by default.
2. Check the group permissions in `groups.json` (**Admin → Groups**):

   | Permission       | Allows                                      | Default                                     |
   | ---------------- | ------------------------------------------- | ------------------------------------------- |
   | `projects`       | Creating user projects                      | `true` for admins, users, authenticated     |
   | `projectSharing` | Adding members to projects                  | `true` for admins, users, authenticated     |

   Both are `false` for `anonymous`. Anonymous users never see user projects, and neither do OAuth
   clients, agents and third-party apps acting for a user; a personal API key acts as its owner.

3. Adjust `platform.projects` if needed: the limits, the sharing audiences and retention (see
   [Platform settings](#platform-settings)).

User projects need a storage provider; without one the page says that projects are not
available on this installation.

### The Projects page

**Projects** in the sidebar lists the projects you own and the projects shared with you. Projects
that administrators created are not listed: they are linked to apps and managed by administrators,
and no chat can start in one. Filter by all, mine or shared, search by name, and create a project with **New project** (name, description,
instructions). The button shows how many projects you have against `maxProjectsPerUser`.

A project page shows:

- **New chat** in the header, the main action: it asks for an app and starts a chat with the
  project attached.
- **Chats** in the project, all or only your own, above the documents so that a long document list
  does not push them down. They come a page at a time (10, 25 or 50, newest first), and the Projects
  page pages its list the same way; a list on these pages never grows with its content.
- **Documents** with status, provenance and size, and the usage against the limits; from six
  documents on the list scrolls inside its card. Owners and editors pin, rename, refresh, preview
  and remove documents and retry failed cloud documents. **Estimate tokens** shows what each
  document and the project weigh.
- **Settings**: name (up to 200 characters), description (up to 2,000 characters) and
  instructions (up to 20,000 characters). The instructions apply to every chat in the project.
- **Members**: the owner, the members, **Share**, **Transfer ownership**, **Leave project** and
  **Delete project**.

### Adding documents

**Add documents** offers one tab per kind the installation allows: upload (several files, drag and
drop), text, web page (checked before it is added), iHub page, iFinder document or search, and
OneDrive / SharePoint, Google Drive and Nextcloud through the cloud file browsers. The text of a
picked cloud file is taken with your account; refresh the item later to take it again.

### Roles and sharing

| Can                                                                  | Owner | Editor | User |
| -------------------------------------------------------------------- | :---: | :----: | :--: |
| See the project, its documents and instructions                      |   ✓   |   ✓    |  ✓   |
| See the member list (users see only how many members there are)      |   ✓   |   ✓    |  —   |
| Chat in it, read other members' chats in it (read-only)              |   ✓   |   ✓    |  ✓   |
| Add, refresh, pin, rename and remove documents; edit settings        |   ✓   |   ✓    |  —   |
| Let a workflow write into it                                         |   ✓   |   ✓    |  —   |
| Change members                                                       |   ✓   |   ✓    |  —   |
| Delete the project, transfer ownership                               |   ✓   |   —    |  —   |

A member is a user, a group (inherited groups count) or everyone signed in; the strongest role
that reaches you wins. The `anonymous` group cannot be a member. A project holds at most 100
members. Who you may add depends on the `projectSharing` permission and on
`platform.projects.sharing`: users and groups by default, everyone signed in only when an admin
allows it.

### Transfer, delete and an owner who leaves

- **Transfer ownership** hands the project to another active user, within that user's project
  limit. Only the ownership moves: a share that reaches the former owner (their own entry, a group
  they are in, everyone signed in) stays in force, so review the members afterwards when the
  handover is meant to end their access.
- **Delete project** removes the project and all its documents. Its chats are kept, outside the
  project. This cannot be undone.
- When the owner's account is **deactivated**, the project stays readable for its members, but
  nobody can change it until a full administrator transfers it.
- When the owner's account is **deleted**, their projects are deleted with it, and their
  memberships in other projects are removed.
- An owner cannot leave; they transfer or delete the project. An editor listed by name leaves with
  **Leave project**.

Full administrators may read and delete any user project, and transfer it, for compliance. They
never edit one.

### Chats in a project

A chat started from the project page runs inside the project: it answers with the project's
instructions and documents (mode `auto`), next to whatever the app itself links. A stored chat
moves into a project, or out of it, from the chat page (**Move to project**, **Change project**) or
from the chat history. Both show which project a chat belongs to. Only user projects hold chats.

Every member may open the chats in a project; chats of other members are read-only.

### Using a project in any chat

A chat does not have to start in a project to use one. Above the message box, **Add project** lists
your own and the shared user projects; tick one and the answers of that chat can use its
documents (the project is loaded or searched like one the chat runs in); its instructions do not
apply, only those of the project the chat runs in and of the app's own links. A chip names each
attached project and links to it; its **×** takes the project away again. Up to 10
projects can be attached. For a stored chat the change is saved at once and is still there when the
chat is opened later; a chat that is not stored yet keeps the choice for its messages. Attaching
does not move the chat into the project: it stays where it is, and the project's members do not
see it. When the chat runs in a shared project, its members read the answers, including what was
drawn from an attached private project.

### Retention

With `platform.projects.retentionDays` above 0, a daily sweep deletes user projects without
activity for that many days, with all their documents. Activity is anything that changes the
project or is done in it: documents added, refreshed, renamed, pinned or removed; settings or
members changed; chats started in or moved into the project; and a message sent in one of its
chats (counted at most once every five minutes). As with **Delete project**, the project's chats are
kept: they leave the project and stay in their owners' chat history. The deletion is audited. The
default, 0, keeps projects until someone deletes them. Admin projects have no retention.

### Not available yet

- **Search box** on the project page: there is no project search endpoint yet; search happens in
  chats through `knowledge_search`.
- **Attaching projects from the chat input**: the chat request accepts `projects`, but there is no
  picker in the chat input yet. A chat reaches a project by starting in it or moving into it.
- **Leaving** as a member with the role _user_, or as a member through a group or everyone.
- **Transfer target search** finds users only when the owner may share with users
  (`projectSharing` and `sharing.allowUsers`).
- **Starting a project chat from the start page**; start it from the project page.
- **Admin projects on the Projects page** are read-only; content admins change them under
  **Admin → Projects**.
- **Compliance listing of user projects** in the admin UI: the API answers
  `GET /api/admin/projects?ownership=user` for full admins, the page shows only the count.

## Platform settings

`platform.json` → `projects`. Platform changes take effect after a server restart.

```json
{
  "projects": {
    "tierPolicy": "ihub",
    "limits": {
      "maxFiles": 25,
      "maxFileBytes": 20971520,
      "maxProjectBytes": 209715200,
      "maxProjectsPerUser": 20
    },
    "sharing": { "allowUsers": true, "allowGroups": true, "allowEveryone": false },
    "retentionDays": 0,
    "loadAllMaxTokens": 50000,
    "kinds": {},
    "encryption": { "keyProvider": "local-file" },
    "scan": { "provider": "none", "command": "", "timeoutMs": 30000, "onError": "reject" },
    "ingest": { "concurrency": 2, "staleAfterMinutes": 30 }
  }
}
```

| Key                         | Default             | Meaning                                                                                                  |
| --------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------- |
| `limits.maxFiles`           | `25`                | Items per project, every kind counted. At most 50.                                                       |
| `limits.maxFileBytes`       | `20971520` (20 MB)  | Size of one uploaded or picked file.                                                                     |
| `limits.maxProjectBytes`    | `209715200` (200 MB) | Sum of the original file sizes in one project.                                                          |
| `limits.maxProjectsPerUser` | `20`                | User projects one person may own; 0 or less means no limit. Admin projects do not count.                 |
| `sharing.allowUsers`        | `true`              | Users may share with individual users.                                                                   |
| `sharing.allowGroups`       | `true`              | Users may share with groups.                                                                             |
| `sharing.allowEveryone`     | `false`             | Users may share with everyone signed in.                                                                 |
| `retentionDays`             | `0`                 | Days without activity after which a user project is deleted; 0 keeps them.                               |
| `loadAllMaxTokens`          | `50000`             | Upper bound of the load-all budget (also capped at 40 % of the model's context window).                  |
| `kinds`                     | `{}`                | Item kinds to switch off, `{ "<kind>": false }`.                                                         |
| `scan.provider`             | `none`              | `none` (no scan) or `command` (run a scanner on every upload and picked file before extraction).         |
| `scan.command`              | `""`                | The scanner command; `{path}` is replaced by the file, or the path is appended. Exit code 0 is clean, 1 infected, anything else an error. |
| `scan.timeoutMs`            | `30000`             | How long the scanner may run.                                                                            |
| `scan.onError`              | `reject`            | What a scanner error does to the file: `reject` fails it, `allow` lets it through.                       |
| `ingest.concurrency`        | `2`                 | Extraction jobs per server process, at most 8.                                                           |
| `ingest.staleAfterMinutes`  | `30`                | After how long a waiting or extracting item counts as interrupted.                                       |
| `tierPolicy`                | `ihub`              | Accepts `ihub`, `both`, `ifinder`; this version implements `ihub` only and treats every value as `ihub`. |
| `encryption.keyProvider`    | `local-file`        | The key provider for document keys; `local-file` is the only one in this version.                        |

A scanner configuration, for example with ClamAV:

```json
{
  "projects": {
    "scan": { "provider": "command", "command": "clamdscan --no-summary --fdpass {path}" }
  }
}
```

## Storage and security

- **Text only, encrypted.** iHub keeps the extracted text of uploaded and picked documents, never
  the original. Each document is encrypted with its own key; that key is wrapped by the
  installation's master key, `TOKEN_ENCRYPTION_KEY` or `contents/.encryption-key`. Losing the
  master key loses every project document. Before you rotate it, read
  [Encryption Key Management](encryption-key-management.md) (`TOKEN_ENCRYPTION_KEY_PREVIOUS`).
- **Where it lives.** Admin projects are JSON under `contents/projects/`; user projects are runtime
  documents of the storage provider; the encrypted text of both is in
  `contents/data/blobs/project-files`. Back up `contents/` as a whole.
- **Cluster workers, not separate instances.** The worker processes of one installation on one
  machine share its master key and `contents/data/blobs/project-files`, so they need no extra
  setup; extraction runs in the worker that received the upload. Separate server instances
  pointed at one `contents/` directory or one blob volume (several hosts, several containers, a
  load-balanced pair) are not supported: the shipped filesystem storage provider reports
  `multiInstance: false` and locks only within one machine, so concurrent writes from another
  instance are not coordinated. Do not share `contents/` or the blob directory between
  installations, not even with the same `TOKEN_ENCRYPTION_KEY`. Running several instances needs a
  storage provider that reports multi-instance support; see
  [Storage Providers → Choosing a provider](storage.md#choosing-a-provider).
- **Malware scan.** Configure `platform.projects.scan` for production installations; without it
  uploads are not scanned.
- **Audit.** Creating, changing and deleting projects and items, sharing, transfers, moving chats
  and retention deletions are audited. Reading a document's text (preview, download, source
  content) is audited only when `platform.audit.logReads` is `true`; it is off by default because
  every citation preview would be an event. Audit summaries never contain document text.
- **Link items** are fetched when they are used: web and iHub pages with a cache, iFinder items
  with the reading user's own rights.

## Workflows and agents

Workflows link projects like apps do, offer a start input of type `project` and have three steps
to list, read and write documents (`project-items`, `project-read`, `project-write`). Agent
profiles carry the same `projects` list. See [Workflows → Projects in a workflow](workflows.md#projects-in-a-workflow).

The MCP gateway lists admin projects as resources `ihub://project/<id>`.

## Migration from sources

Upgrading to this version migrates sources to admin projects (migrations `V174__sources_to_projects`
and `V175__support_bot_knowledge_prompt`):

- Every entry of `config/sources.json` becomes `contents/projects/<id>.json` with one item of the
  source's kind. The project keeps the source id when it is a valid admin project id: at most 50
  characters and not starting with `prj_`. Every other id is remapped, in the project file and in
  every reference to it:

  | Source id                                    | Project id                                  |
  | -------------------------------------------- | ------------------------------------------- |
  | Valid admin id (`faq`)                       | Unchanged (`faq`)                           |
  | Starts with `prj_` (`prj_case`)              | `legacy-<id>` (`legacy-prj_case`)           |
  | `legacy-<id>` would exceed 50 characters     | `legacy-` and a 12-character hash of the id |
  | `legacy-<id>` is another source's project id | `legacy-` and a 12-character hash of the id |

  For example, with the sources `prj_case` and `legacy-prj_case`, `legacy-prj_case` keeps its id
  and `prj_case` gets a hashed id. The migration logs every remap at level `info` as
  `Source "<old>" is remapped to "<new>"` (component `Migration`, version `174`) in the server log,
  `logs/app.log` when file logging is on (see [Logging](logging.md)). Search the startup log for
  these lines to find a renamed project and to update API clients and external references that
  use the old id.
- `sources` on apps, workflows, workflow steps, planner task templates and agent profiles becomes
  `projects`: a prompt source `{ "id": "…", "mode": "context" }`, a tool source
  `{ "id": "…", "mode": "tools" }`. A configuration that still says `sources` fails validation.
- `{{sources}}` and `{{source}}` become `{{projects}}`. `source_<id>` tools are removed; the
  knowledge tools are added at runtime. The shipped iHub Support Bot prompt is updated when it was
  not customised.
- The feature flag `sources` and the page switch `admin.pages.sources` become `projects`.
- Files under `contents/sources/` are imported into encrypted storage at the first start and
  deleted once their item is **Ready**. A **Failed** item names the file it could not import; the
  next start retries it.
- `config/sources.json` is kept as `config/sources.json.migrated` for reference and no longer read.

Back up `contents/` before upgrading; the migration is forward-only. Details: the breaking-change
note "Sources are now Projects" in the release notes.

Every source becomes a project of its own, also when several sources belonged together (the pages
of one website, the documents of one department). Bring them together afterwards with
[Moving, copying and merging](#moving-copying-and-merging): merge the projects, or move the items
you want into one project.

## API

All paths are relative to the server's base path. Project errors carry their code in
`details.code`, next to any further details (for `PROJECT_IN_USE`, the dependencies):

```json
{ "error": "Project not found", "details": { "code": "PROJECT_NOT_FOUND" } }
```

The codes are the ones named on this page plus `PROJECT_NOT_FOUND` (also "no access"),
`PERMISSION_DENIED`, `USER_PROJECTS_DISABLED`, `QUOTA_*`, `KIND_DISABLED`, `INVALID_REF`,
`SHARE_TARGET_INVALID`, `PROJECT_MISMATCH` and `STORAGE_UNAVAILABLE`. Generic errors (a plain
"not found", a validation failure, an unexpected server error) may come without `details` or
without a code.

The chat request is different: a project it names but may not use is answered with the code at the
top level:

```json
{ "error": "Project not found", "code": "PROJECT_NOT_FOUND" }
```

### User API

Every route needs the `projects` flag and a signed-in user. User projects also need the
`userProjects` flag: while it is off, every route of a user project, reads included, answers
`403` with the code `USER_PROJECTS_DISABLED` for everyone but a full admin, who keeps access for
compliance work. _Who_ is the least role on the project: member (any role), editor or
owner. On an admin project, anyone whose app, workflow or agent links it counts as a member;
changing it takes a content admin.

| Method   | Path                                          | Who       | What it does                                                                                     |
| -------- | --------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------ |
| `GET`    | `/api/projects/_config`                       | —         | Flags, limits, sharing audiences, enabled kinds, accepted upload types, your project count.      |
| `GET`    | `/api/projects`                               | —         | Your projects; `?scope=all` (default), `mine`, `shared` or `admin`.                               |
| `POST`   | `/api/projects`                               | `projects` permission | Create a project `{ name, description?, instructions? }`.                                        |
| `GET`    | `/api/projects/share-targets?q=`              | —         | Users and groups you may share with.                                                             |
| `GET`    | `/api/projects/:projectId`                    | member    | The project with its items and your `permissions`.                                               |
| `PATCH`  | `/api/projects/:projectId`                    | editor    | Change `name`, `description`, `instructions`.                                                    |
| `POST`   | `/api/projects/:projectId/estimate`           | member    | Tokens of every document and the recommendation (prompt or search).                              |
| `DELETE` | `/api/projects/:projectId`                    | owner     | Delete the project and its documents.                                                            |
| `GET`    | `/api/projects/:projectId/items`              | member    | The items.                                                                                       |
| `POST`   | `/api/projects/:projectId/items`              | editor    | Add an item: multipart field `file` (plus `name`, `pinned`), or JSON `{ kind, ref, name?, pinned? }`, or `{ kind: "upload", text, name }`. Text kinds answer `202` while extracting, link kinds `201`. |
| `GET`    | `/api/projects/:projectId/items/:itemId`      | member    | One item; poll it while it extracts.                                                             |
| `PATCH`  | `/api/projects/:projectId/items/:itemId`      | editor    | Change `name`, `pinned`.                                                                         |
| `DELETE` | `/api/projects/:projectId/items/:itemId`      | editor    | Remove the item.                                                                                 |
| `POST`   | `/api/projects/:projectId/items/:itemId/refresh` | editor | Take the text of a picked file again, with your account.                                         |
| `PUT`    | `/api/projects/:projectId/items/:itemId/text` | editor    | Replace the text of an uploaded, written or imported document: `{ text }`. Links and picked documents are refused (`INVALID_REF`). |
| `GET`    | `/api/projects/:projectId/items/:itemId/text` | member    | The text as `text/plain`; `?maxChars=`, `?download=1` saves it as `.txt`.                        |
| `PUT`    | `/api/projects/:projectId/members`            | editor    | Replace the member list `{ members: [{ type, id?, role }] }`.                                    |
| `POST`   | `/api/projects/:projectId/transfer`           | owner     | Hand the project to `{ ownerId }`.                                                               |
| `GET`    | `/api/projects/:projectId/chats`              | member    | The chats in the project, newest first, a page at a time: `?filter=all`, `mine` or `others`; `limit` (default 20, at most 100) and `cursor`. Answers `{ items, nextCursor, total }`. |
| `PATCH`  | `/api/chats/:chatId`                          | chat owner | `{ projectId }` moves a chat into a user project, `{ projectId: null }` out of it. `{ attachedProjectIds }` replaces the projects attached to the chat (new ones need the right to use them; `404` otherwise). |

The chat request (`POST /api/apps/:appId/chat/:chatId`) accepts `projectId`, the project the chat
runs in (first turn; a different one later answers `PROJECT_MISMATCH`), and `projects`, projects
attached to the chat for their documents only.

Picker helpers, needing the `projects` flag and a signed-in user:

| Method | Path                                    | What it does                                                    |
| ------ | --------------------------------------- | --------------------------------------------------------------- |
| `GET`  | `/api/projects/pickers/pages`           | iHub pages you may read, with their languages.                  |
| `GET`  | `/api/projects/pickers/ifinder/search`  | iFinder search with your rights; `?q=&profile=&limit=`.         |
| `GET`  | `/api/projects/pickers/ifinder/metadata` | One iFinder document's metadata; `?documentId=&profile=`.      |
| `POST` | `/api/projects/pickers/url/check`       | Check a URL `{ url }` before adding it.                         |
| `GET`  | `/api/projects/pickers/cloud`           | The enabled cloud storage providers.                            |

### Admin API

Content admins, behind the `projects` flag. User projects are reachable by full admins only.

| Method   | Path                                        | What it does                                                                                |
| -------- | ------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `GET`    | `/api/admin/projects`                       | Admin projects, disabled ones included. `?ownership=user` lists user projects (full admins). |
| `GET`    | `/api/admin/projects/_stats`                | Counts of admin and user projects, items by kind, the limits.                               |
| `GET`    | `/api/admin/projects/_kinds`                | Every item kind with whether it is enabled.                                                 |
| `GET`    | `/api/admin/projects/_config`               | Upload availability and accepted types, scan provider, limits, `loadAllMaxTokens`.          |
| `GET`    | `/api/admin/projects/_tokens`               | Size of each admin project and the budgets, for the app editor.                             |
| `GET`    | `/api/admin/projects/_dependencies/:id`     | Apps, workflows and agents that link the project.                                           |
| `POST`   | `/api/admin/projects/:id/estimate`          | Tokens of every item and the recommendation (prompt or search) per item and for the project. |
| `POST`   | `/api/admin/projects/_toggle`               | Enable or disable projects `{ ids, enabled }`.                                              |
| `POST`   | `/api/admin/projects/_merge`                | Merge projects `{ sourceIds, targetId, deleteSources? }`: moves the items, re-points the links, optionally deletes the emptied projects. Answers `{ target, sources: [{ id, moved, failed, relinked, merged, deleted }] }`. |
| `POST`   | `/api/admin/projects`                       | Create an admin project.                                                                    |
| `GET`    | `/api/admin/projects/:id`                   | One project (a user project for full admins).                                               |
| `PUT`    | `/api/admin/projects/:id`                   | Replace the settings; items change through the item routes.                                 |
| `PATCH`  | `/api/admin/projects/:id`                   | Change some settings.                                                                       |
| `DELETE` | `/api/admin/projects/:id`                   | Delete; `PROJECT_IN_USE` with the dependencies while something links it.                    |
| `POST`   | `/api/admin/projects/:id/items`             | Add an item, as in the user API.                                                            |
| `PATCH`  | `/api/admin/projects/:id/items/:itemId`     | Change `name`, `pinned`.                                                                    |
| `DELETE` | `/api/admin/projects/:id/items/:itemId`     | Remove an item.                                                                             |
| `POST`   | `/api/admin/projects/_move`                 | Move items into another admin project `{ sourceId, targetId, itemIds }`. Answers `{ transferred, failed, source, target }`; an item that cannot go is in `failed` with its code. |
| `POST`   | `/api/admin/projects/_copy`                 | The same body and answer; the items stay in the source.                                     |
| `POST`   | `/api/admin/projects/:id/items/:itemId/refresh` | Refresh an item.                                                                        |
| `PUT`    | `/api/admin/projects/:id/items/:itemId/text` | Replace the text of an uploaded, written or imported document: `{ text }`.                  |
| `GET`    | `/api/admin/projects/:id/items/:itemId/text` | The stored or fetched text as `text/plain`.                                                |
| `POST`   | `/api/admin/projects/:id/test`              | Read every item the way a chat would.                                                       |
