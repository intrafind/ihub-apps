# Features — Unreleased

## Projects: One Place for the Knowledge of Apps, Workflows and Agents

**Admin → Projects** replaces Sources. A project holds documents, links and instructions, and
admins link it to apps, workflows, workflow steps and agents. Existing sources are converted
automatically (see Breaking Changes).

- **Add documents in many ways:** upload PDF, Word, PowerPoint, Excel, OpenDocument, HTML, e-mail
  (`.eml`, Outlook `.msg`), Markdown, CSV, JSON, XML and text files, or type or paste a text. Links
  to a web page, an iHub page, an iFinder document or an iFinder search are read when they are
  used, with the rights of the person asking.
- **Stored encrypted:** iHub keeps only the extracted text, encrypted per document. The original
  file is discarded. A scanned PDF without a text layer is reported instead of being stored empty.
  A document can hold up to 10 million characters (about 10 MB of text).
- **Loaded or searched as needed:** each link has a mode. `context` always puts the text into the
  prompt, `tools` lets the model search it, and `auto` (the default) loads it in full while it
  fits and searches it otherwise. Pinned documents are always loaded. The chat shows which of the
  two happened, and every answer cites the documents it used.
- **Instructions:** a project's instructions are added to the system prompt of everything that
  links it, for example "answer only from these contracts".
- **Simple to set up:** **New project** is one short form. **Who can use this project?** offers
  **Linked apps only** (the default), **Everyone signed in** or **Off** (a draft). After creating
  it, **Add item** opens straight away. A project's page shows its documents first, with its
  settings beside them, and changes to the settings are saved from small dialogs.
- **Check before you rely on it:** **Test** reads every item the way a chat would. **Estimate
  tokens** counts the tokens of each document and recommends whether the project belongs in the
  prompt or is better searched.
- **Tidy up:** move or copy items into another project, or merge several projects into one. A
  merge re-points the apps, workflows and agents that linked the merged projects.
- **Per app:** **Admin → Apps → Edit → Projects** has the switches **Use projects in this app** and
  **Allow personal projects**, both on by default.
- **Limits** for files per project, file size and project size, and an optional malware scan of
  uploads (`projects.scan`), are set in `platform.projects`.

See [Projects](../../projects.md).

## Projects for Users (Preview)

Users can now keep their own projects: documents, instructions and chats in one place, private
until they share them. This is a preview and is off by default: turn on the `userProjects` feature
flag under **Admin → Platform → Features**. The group permissions `projects` and `projectSharing` decide who
may create and share projects.

- **Projects** in the sidebar lists your own projects, those shared with you and those you added
  from the catalog, with a search field.
- **Chat in the project:** a project page has the same chat input as the start page. Send a message
  and a chat starts in the project, answering with its instructions and documents. Each project has
  a **default app** for its chats; you can pick another one above the input. The project's chats
  are listed on its page.
- **Use a project in any chat:** **Project** in the chat input (also on the start page) attaches
  one or more projects to the current chat, up to 10. Their documents are then available to the
  answers; the chat stays where it is.
- **Add documents** by upload (several files at once), from OneDrive / SharePoint, Google Drive or
  Nextcloud (refreshable later), or as a web page, iHub page or iFinder document or search. Each
  document shows its status, and can be pinned, renamed, refreshed or removed.
- **Share** with users, groups or everyone signed in, as *user* (chat and read) or *editor* (also
  change documents, instructions and members). Owners can transfer a project to another user,
  after a confirmation that says what the new owner may do and which shares stay in force, or
  delete it.
- **Citations** show where a document came from, for example "Picked from SharePoint · text taken
  12 Oct 2026", and the preview highlights the passages that were cited.

## Projects: Share One Project With Everyone, and Reuse Documents Without Copying

A few people can now maintain a project that everyone else uses.

- **Project catalog:** owners publish a project with **Publish to the catalog**. Users find it under
  **Projects → Browse catalog** and add it to their own list. They use its documents in their
  chats; their chats stay their own. The catalog is off by default
  (`platform.projects.sharing.allowCatalog`).
- **Admin projects for everyone:** an admin project set to **Everyone signed in** can be used and
  linked by everyone signed in and, while the catalog is on, appears in it as **From the
  administrators**. The shipped iHub documentation project is available to
  everyone signed in by default, also after an upgrade.
- **Link documents from another project:** **Add documents → From another project** links
  documents of your own projects, or of published ones, without copying them. A chat always reads
  the current original, and a link takes no storage. Everyone reads a linked document with their
  own rights: whoever may not use the source project sees **No access**.
- **Admin → Projects → Sharing of user projects** decides which sharing options users get: specific
  users, groups, everyone signed in, and the catalog.
- Badges show at a glance what kind of project you are looking at: **Global**, **Published** or
  **From the catalog**.

## Projects: Add the Pages of a Website in One Go

The **Web page (URL)** tab of **Add item** / **Add documents** has two new helpers:

- **Preview** shows the text the model will get from a page before you add it. A page that needs
  JavaScript or blocks automated access shows up as empty or short text.
- **Find more pages of this website** follows the page's links within the same website (by default
  within the start page's section, 2 links deep and up to 50 pages; at most 3 links and 200 pages)
  and lists what it finds with titles. Filter, tick pages or **Select all**, and **Add N pages** adds each one as its own item.
  Pages already in the project are marked. The search respects the website's `robots.txt`, skips
  tracking parameters and endless page lists, and stops after 25 seconds with what it has found.

## Workflows: Read and Write Project Documents

Workflows can now work through the documents of a project and store their results in one.

- New steps: `project-items` (the documents of a project as a list to loop over), `project-read`
  (the text of one document) and `project-write` (store a text the run produced).
- Writing into an admin project needs `write: true` on the workflow's project link. A user project
  accepts writes from its owner and editors.
- A start input of type `project` lets the person running the workflow pick one of their projects,
  for example for "one project per case" workflows.

See [Workflows](../../workflows.md).

## Scheduled Tasks: Keep Fewer Runs, and Delete Runs

A scheduled task can now limit its run history by number (keep at most N runs) and by age (delete
runs older than D days); both are set in the task editor. Runs past a limit are deleted together
with their chats; runs in progress are never touched. Admins can set an installation-wide maximum
with the new **Keep at most this many runs per task** setting (`maxRunsPerTask`) under **Admin → Scheduled
Tasks**; the stricter of the two limits applies.

Runs can also be deleted by hand on the task page: one run, a selection, or all finished runs.

## Turn Off the First-Run Onboarding for Everyone

**Skip** in the setup wizard used to skip it only for the current browser session, so it came back
in every new tab, browser or for every other user. **Admin → Platform → Advanced → First-run onboarding** now
has a switch (`setup.disabled`) that stops the redirect to the wizard for everyone. When an admin
skips the wizard, they are asked whether to hide it for good.

The page also warns when a demo account (`admin` / `user`) still signs in with its shipped
password, and the admin start page shows an onboarding box until onboarding is completed.

## OpenRouter as a Provider; Built-In Providers Come With Their API URL

OpenRouter is now available next to OpenAI, Anthropic and the other providers, and is added on
upgrade unless an `openrouter` provider already exists. In **Admin → Models → Import from URL**,
choose **OpenRouter**, enter your key, load the model list and import the models you want. Models
that generate images or audio instead of text are marked and not included in **Select all**.

A key entered during the import for a provider that has none yet is stored encrypted on the
provider, so the imported models work right away. You can also set the key under **Admin →
Providers** or in `OPENROUTER_API_KEY`.

The OpenAI, Anthropic, Google and Mistral providers now carry their public API base URL, so choosing one of them in **Import from URL** fills in the endpoint and **Load models** works right away, with no URL to look up (for Google, `https://generativelanguage.googleapis.com/v1beta`). Updates add the URL to these providers unless one is already set. Change it in the dialog for one import, or under **Admin → Providers** to keep it, for example for a proxy or a regional endpoint. **Local LLM** has no fixed address; enter your server's URL there. A wrong Google API key is now reported as a rejected key instead of a bare "HTTP 400".

## New Installations Start Without Cloud Models

A new installation no longer ships preconfigured Gemini, Claude, GPT and Mistral models. It starts with the disabled local models only (vLLM chat, Voxtral transcription on vLLM, iAssistant), and you add the cloud models you want from the provider: while fewer than five models are configured, **Admin → Models** shows **Import from provider** and **Create new model** in the middle of the page, and the setup wizard ends with **Add your models** for the provider you connected. The first chat model you enable becomes the default. The former model configurations are in the **iHub Examples** registry under **Admin → Marketplace**. Existing installations keep their models unchanged.

**Import from URL** now also sets up the speech models of Google and Mistral: Gemini transcription and live transcription, Gemini text-to-speech, and Voxtral realtime transcription and text-to-speech are imported as transcription or text-to-speech models, ready for voice input, recording and read aloud. A speech model iHub cannot run, such as Mistral's batch transcription, is listed but cannot be picked. Such models imported through a custom provider use that provider's API key.

## iHub Trusts the Server's Own Certificate Store

A company CA installed on the server (Linux CA store, Windows or macOS certificate store) is now
trusted for every outbound TLS connection, such as LLM endpoints, MCP servers and `wss://` voice
transcription, in addition to Node's built-in certificates. Nothing needs to be configured, and the
Docker image, the binaries and `npm start` behave the same. Set `NODE_USE_SYSTEM_CA=0` to turn it
off. This needs Node 24.5 or later; on older versions set `NODE_USE_SYSTEM_CA=1` or
`NODE_EXTRA_CA_CERTS` instead.

## Workflow Editor: Connect Steps With the Keyboard

Selecting a step now shows a **Connections** section in its settings panel. It lists the step's
outgoing connections and lets you add one (choose the target step, and the Yes/No branch for a
decision), edit its condition or remove it, without dragging lines on the canvas. The delete button
of a step now also appears when the step has keyboard focus, not only on mouse hover.

## A Shorter `config.env` in the Binary Distribution

The `config.env` that ships with the binaries now lists only the process settings (`PORT`, `HOST`,
`WORKERS`, HTTPS certificates, `NODE_EXTRA_CA_CERTS`, `CONTENTS_DIR`). LLM and web search keys
belong in the setup wizard or **Admin → Providers**, where they are stored encrypted. Existing
installations keep their own `config.env`, and keys already set as environment variables keep
working.

## Apps No Longer Carry an Empty `{{content}}` Prompt Template

A prompt template that consists only of `{{content}}` changes nothing, because the message is sent
as typed anyway. The app creator no longer adds one, and the upgrade removes it from existing apps.
Templates with other text around `{{content}}` are kept.

## Scheduled tasks: keep fewer runs, delete runs

A scheduled task can now limit its run history by **count** (keep at most N runs) and by **age**
(delete runs older than D days); set both in the task editor. Runs past a limit are deleted together
with their chats, and runs in progress are never touched. Administrators can set an installation-wide
cap with the new `maxRunsPerTask` setting next to `runRetentionDays` (Admin → Scheduled Tasks); the
stricter of the platform and the task limit applies.

Runs can also be deleted by hand from the task page — one run, a selection, or all finished runs.

**Upgrade note:** the periodic age sweep (`runRetentionDays`, default 90) now deletes the run's chat
together with its run record. Before, it removed only the record and left the chat to the chat
retention rules, so installations that keep chats longer than 90 days will now lose scheduled-run
chats at that age. Set `runRetentionDays` to `0` to keep run history and its chats indefinitely.

## Default app for admin projects

Admin-created projects can now have a default app, just like personal projects.
Set it in the project's name and description dialog; chats in the project then start in that app,
so users who add the project to theirs get the right app selected automatically. They can still pick another app.

## E-Mail Files Through the API, and `.msg` in More Upload Fields

The OpenAI-compatible API now accepts e-mail files as `input_file`: `.eml` and Outlook `.msg`. The
model reads them as it does in the chat upload: subject, sender, recipients, date and body, with
attachments named but not read.

- A `.msg` is recognised by its file name, whatever content type the client sends it with.
- New apps offer Outlook `.msg` among their default upload formats, and so do workflow file inputs
  that list no formats of their own.
  
## People Search in Chat: Company Directory and x500.bund.de

Users can ask the chat for people — function, unit, phone, e-mail — in the company's LDAP or
Active Directory and in external directories such as the directory of the German federal
administration, x500.bund.de. The model picks the directory by its description and can search
several in one answer; every hit names the directory it came from.

- **Admin → Integrations → People directories** lists the directories, with an editor, a
  connection test that shows each step and the mapped results, and a Certificates tab.
- **Use for people search** on an LDAP sign-in provider creates the company directory in one
  click. Searching needs the provider's bind account.
- x500.bund.de ships as a disabled entry. It connects over LDAPS and trusts the Verwaltungs-PKI
  root `PCA-1-Verwaltung-23`, which iHub ships, checked against the fingerprint the BSI publishes.
  The iHub server needs a direct route to port 636; LDAP does not use the HTTP proxy.
- The new **People search** app uses every directory a user may use. It ships enabled and
  appears for users as soon as one directory is switched on under **Admin → Integrations →
  People directories**; until then users do not get it (`requiredIntegrations`).
- Each directory has its own groups, on top of the tool permissions. Plain-text LDAP, private
  addresses and untrusted certificates are refused unless allowed explicitly.

See [People Directory Search](../../people-directory-search.md).

## iFinder Apps Appear With the iFinder Integration

The **iFinder Search** and **iAssistant** apps now ship enabled and show up for users as soon as
the iFinder integration is switched on under **Admin → Integrations → iFinder**; while it is off,
users do not get them. Apps declare this with the new `requiredIntegrations` field (currently
`["ifinder"]`); Admin → Apps still lists them, marked as hidden.

Saving a complete iFinder setup (integration on, base URL set) also switches on the
**iAssistant Conversation** model, so the iAssistant app works without a visit to Admin → Models.
A model an admin disables afterwards stays disabled.

Installations that are already configured keep the model as it is; the upgrade adds the
requirement to the two apps and leaves their enabled state alone.

## Updates: Install From File for Servers Without Internet Access

Binary installations can now be updated without any outbound connection. Download the release
archive on another machine and hand it to iHub under **Admin → Updates → Install from file**:
upload it, or copy it to the server and enter its path (or drop it into the `updates/` folder of
the installation). iHub verifies it and shows a summary — version, platform, signature, checksum,
warnings — before anything is changed; you confirm, and the server restarts into the new version.

- The page names the exact file the server needs, e.g. `ihub-apps-v5.7.0-linux.tar.gz`.
- Every update, online or from a file, is now checked against an Ed25519 signature and file by file
  against the archive's signed manifest; archives for the wrong platform or CPU architecture,
  tampered or truncated archives and archives with unsafe paths are refused before anything is
  touched. Downgrades need an extra confirmation.
- The files are replaced by the launcher before the server starts. If the new version fails to
  start three times, the previous version and its configuration are restored automatically, and
  the Updates page says why.
- A snapshot of the configuration is taken before every update; rolling back can restore it.
- On the command line: `--update=install --file=<archive>`, `--update=status`,
  `--update=rollback --restore-config`.
- See [Binary Installation Updates](../../INSTALLATION.md#binary-installation-updates).

## Projects: Your iFinder Smart Collections as Projects

With the tier policy set to `both` or `ifinder` (**platform.json → projects.tierPolicy**, until now
accepted but ignored), iFinder 6.8 or later configured and **User Projects** switched on (**Admin →
Platform → Features**), a user's iFinder smart collections appear on the **Projects** page next to
their own projects, marked **iFinder**. Opening one lists its documents. A chat can use the
collection as knowledge: tick it in the **Project** picker of the chat input, or start a chat from
its page. Nothing is copied: the documents stay in iFinder and are read, searched and cited with
the rights of the person asking, like any iFinder document in a project. A document the reader may
not open is named as unavailable.

Owners can also manage their collections from iHub:

- **Create** a collection from **New project** by choosing **As an iFinder smart collection**
  (name and description). The owner is the signed-in user; the collection also shows up in iFinder.
- **Rename** it, and change its description.
- **Add documents** with the iFinder document picker. iHub first checks that the user can read each
  document, because iFinder checks nothing on add; if one is not readable, nothing is added. A
  collection holds at most 200 documents, shown as a bar on the page; going over is refused with a
  clear message.
- **Remove documents.** Only the membership is removed, never the document.
- Not part of iHub: sharing, deleting a collection, and any other kind of item (files, web pages,
  text). Instructions, pins, members and the token estimate do not apply to a collection.
- **Writes are serialized across all iHub instances.** iFinder changes a collection with an
  unversioned read-and-write, so two overlapping changes would lose one. iHub takes a lock from the
  storage layer for each collection. Where the storage is multi-instance and has no cluster-wide
  lock (today: every installation that runs several instances on the filesystem provider), changing
  collections is switched off, collections stay readable, and `GET /api/projects/_config` reports
  `ifinder.writable: false` with the reason. Changes made in iFinder itself are not covered by that
  lock.
- **iFinder can fail in the middle of a change.** The call is not atomic. iHub reads the collection
  again and tells the user which documents did and did not make it; repeating the call is safe.

Also:

- **Only where iFinder can serve it:** the tier is offered when iFinder is configured, the policy
  allows it and the Smart Collections API answers; an older iFinder never shows it. The user needs
  the `fi_smartcollections` role in iFinder and a login name iHub can sign for iFinder (the
  **JWT Subject Field** setting; users without one, and anonymous users, see nothing).
- **Same identity on both sides:** a collection belongs to the name iHub signs into the iFinder
  token. iFinder's list matches that name exactly, upper and lower case included, so a collection
  whose owner differs only in case is missing from the list (it still opens by id). Set the
  **JWT Subject Field** so it produces the user's iFinder login exactly. A new or renamed
  collection can take up to about ten seconds to appear in iFinder's own list; iHub shows it at
  once.
- **If iFinder is slow or down,** the project list still loads, with a note that the collections
  are missing. A chat that has a collection attached still answers; the model is told the
  collection is unavailable and says so, and the answer shows a **not available** notice.
- **Searched, never loaded in full:** a collection holds up to 200 documents, so a chat searches it
  instead of putting every document into the prompt.
- **Local projects stay creatable under every policy**, including `ifinder`.
- Admin project IDs starting with `ifc_` are now reserved for collections, as `prj_` is for user
  projects.

See [Projects](../../projects.md#the-ifinder-tier-smart-collections).

## iAssistant: Search Profiles per User, iFinder iAssistants in Apps, and iFinder 6.9

Search profiles are assigned per user in iFinder, but an iAssistant app names one search profile
for everyone. iHub now reads the search profiles of the user before it starts an iAssistant
conversation — the same list the iFinder searchbar offers them — and uses the user's default
profile when they do not have the configured one. Before, such a user got a conversation that
could not find anything.

- **Setting:** `iAssistant.verifySearchProfileAccess` (on by default) in `platform.json`. It
  replaces `resolveSearchProfileFromProfile`, which read the conversation profile for a search
  profile that iFinder never publishes there; the update renames the key and keeps its value.
  `profileCacheTtlMs` becomes `searchProfileCacheTtlMs`.
- The list is read for one iFinder application, `iFinder.searchProfileApplication` (default
  `ifinder`, the searchbar's). Set it if your iAssistant profiles are assigned under another
  application.
- If iFinder cannot be asked, the configured profile is used as before. iFinder 6.9 refuses the
  request for users without the feature `fi_ifinder_allow`.
- **iFinder iAssistants in apps:** an app can name an iFinder iAssistant
  (`iassistant.assistantId`), which brings its conversation profile and search profile with it.
  **Admin → Apps → Edit → iAssistant** lists the iAssistants iFinder shows you. Users without
  the iAssistant's search profile are told it is not available to them.
- **All search profiles:** with `iassistant.allSearchProfiles`, an app sends no search profile and
  iFinder 6.9 searches everything the user may see through any of their profiles.
- **iFinder search tool:** `iFinder_listProfiles` lists the search profiles the user has, with
  their names and the user's default, instead of only the profiles some iAssistant uses.
- **iFinder 6.9:** iHub sends each question as an append to the conversation and passes the user's
  language. When the conversation was continued elsewhere, for example in the iFinder Workspace,
  the question is added after the last message instead of failing. A background task that a turn
  starts is shown as a status.
