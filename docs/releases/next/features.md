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
flag under **Admin → Features**. The group permissions `projects` and `projectSharing` decide who
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
- **Admin projects for everyone:** an admin project set to **Everyone signed in** appears in the
  catalog as **From the administrators**. The shipped iHub documentation project is available to
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
in every new tab, browser or for every other user. **Admin → Advanced → First-run onboarding** now
has a switch (`setup.disabled`) that stops the redirect to the wizard for everyone. When an admin
skips the wizard, they are asked whether to hide it for good.

The page also warns when a demo account (`admin` / `user`) still signs in with its shipped
password, and the admin start page shows an onboarding box until onboarding is completed.

## OpenRouter as a Provider

OpenRouter is now available next to OpenAI, Anthropic and the other providers, and is added on
upgrade unless an `openrouter` provider already exists. In **Admin → Models → Import from URL**,
choose **OpenRouter**, enter your key, load the model list and import the models you want. Models
that generate images or audio instead of text are marked and not included in **Select all**.

A key entered during the import for a provider that has none yet is stored encrypted on the
provider, so the imported models work right away. You can also set the key under **Admin →
Providers** or in `OPENROUTER_API_KEY`.

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
