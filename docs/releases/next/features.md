# Features — Unreleased

## Personal Apps: Configure the Chat, the Models, Web Search and Projects — and Let the Builder Do It

Authors of a personal app can now set more of what an administrator sets in an app, and the
conversation builder can propose it. Everything that adds cost or access is switched off until an
administrator allows it.

- **Advanced** (a new, closed group of the editor) sets the greeting of the empty chat, a single
  line or a tall input field, plain or formatted answers, a start form, the input panel and
  **Auto-start conversation**. None of it gives the app a tool or more data. When someone else
  opens an app with auto-start, the first answer counts against their own usage limit.
- **Models:** an app can be limited to a list of models and can lock the choice to its preferred
  model. The list only narrows what a person may use. If a person may use none of the models, the
  chat does not start and says so, instead of using a model the author excluded.
- **Web search:** an author can set how many pages the app opens per answer and add research
  guidance. **Admin → Apps → Personal apps → Settings → Most pages an app may open per answer**
  (`userApps.capabilities.webSearchLimits.maxPageReads`, 10 by default) is the limit.
- **Projects:** an app can answer from up to three projects once an administrator allows it
  (`userApps.capabilities.projects`, off by default). An app never gives anyone access to a
  project: a person gets documents only from projects they may use themselves, and so must the
  owner. A chat of a personal app runs in no project and attaches none, and a linked project's
  instructions are not added to the prompt. A published app links the projects of the company; a
  project of a person stays theirs.
- **The builder** proposes these settings. Settings that only change how the chat looks and starts
  are part of the change; a model, a list of models, research settings and projects are separate
  unticked items that you tick. It leaves out what the installation does not allow and what you
  may not use.
- **Fewer approval cards in a shared app:** the project knowledge tools do not ask before every
  search any more, because they only read and keep the data inside iHub. Web search, the page
  reader and connected systems still ask.
- **Project knowledge tools now count as reads everywhere.** Their shipped definition declares
  them read-only and internal. Where **Admin → Security → Tool approval** asks for internal tools
  "unless the call only reads", a company app that links a project no longer asks before a
  knowledge search; with "always ask" it still does.

**Before upgrading:** nothing to do. Migration V263 adds the two new settings to
`platform.userApps`; both keep the behavior of today. If you ask for approval of internal tools
unless the call only reads and want knowledge searches to ask as before, set that mode to
"always ask" for the tool.

## Models: Sync Models with AWS Bedrock

**Sync models** on the AWS Bedrock provider page, and **Sync with provider** on a Bedrock model, now
work. iHub reads the models of the provider's AWS region (else `AWS_REGION` on the server, else
`AWS_DEFAULT_REGION`, else `eu-central-1`) and offers the models Bedrock lists that nobody added yet, and changes of image input
for the models you added from that region.

- A model added through the sync keeps that region, like a model from the connect flow.
- Models you added from another region are left alone.
- A Bedrock model is never offered for disabling because the listing no longer shows it: a model can
  use an application inference profile or a custom model that the listing does not name.
- A region on the provider that is not an AWS region stops the sync with a message instead of
  reading another region.

## Chat: A Message That Is Too Large Says So

When a message with its attachments is refused for its size, the chat now says who refused it and
what to do, instead of "Request failed with status code 413" or "Payload Too Large".

- A reverse proxy in front of iHub refused it (nginx allows only 1 MB per request unless
  `client_max_body_size` is raised): the chat asks the user to remove or shrink an attachment and
  names the proxy's request limit as the thing to tell the administrator if small files fail too.
- iHub refused it (`requestBodyLimitMB` in `platform.json`): the chat says the message is larger
  than iHub accepts.
- A document that a proxy refused while it was saved to the chat shows "Too large for the
  connection to iHub" instead of the general "Could not be saved", and is still sent with the
  message.

## Web Search: Search Through Your Own SearXNG Instance

Web search can now go through a [SearXNG](https://docs.searxng.org/) instance you run yourself. The
search traffic of iHub then goes to a gateway under your control instead of a search vendor's API.

- **Admin → Integrations → Web search → SearXNG** installs the engine. The **Instance URL** is
  required (`https://search.example.org`, a trailing `/search` is removed). SearXNG has no API key:
  if a reverse proxy in front of it asks for a sign-in, pick a credential in **Authorization**; it is
  sent as a bearer token, or as it is when it starts with `Basic `.
- The instance must list `json` under `search.formats` in its `settings.yml`. SearXNG answers
  HTTP 403 otherwise, and **Test connection** says so, together with the other usual causes (wrong
  path, the limiter, a rejected credential, engines that do not answer).
- Apps use it with `websearch.provider: "searxng"`. On **Auto** it comes after Brave and Staan, so
  existing installs do not change.
- SearXNG forwards each query to the engines enabled in it. Queries leave your network if those
  are external engines: the control is yours, the engines' view of the query is decided in the
  instance.
- The instance address is checked like any other admin-entered URL: company-internal addresses
  work as they are, while `localhost`, link-local and cloud-metadata addresses need the host on
  `ssrf.allowedHosts` (Admin → Security). The connection goes to the checked address and a
  redirect is reported, not followed.
- Its hits are listed in the chat but stay private (a shared chat does not keep them), because an
  instance may search an intranet as well.
- SearXNG is AGPL-licensed software you operate; iHub only calls its HTTP API and does not bundle
  it. See [Web tools](../../web-tools.md#searxng-your-own-search-gateway) for the setup, the licence
  notes and the troubleshooting table.

## Use a Generated File in Another App, or Keep It in a Project

A file the assistant generated in a chat, such as a summary, a report or a spreadsheet, can now be
passed on instead of downloaded and uploaded again.

- **Use in app** opens a new chat of the app you pick with the file attached, as if you had
  uploaded it there. It works on a generated file and on a project document. The picker lists only
  apps that take files of that type.
- **Copy to project** stores the file in one of your projects, or a new one, as if you had uploaded
  it. Who sees it is decided by the project's members; every app that uses the project can read it.
- Both make a **copy**: deleting the chat, or the project document, does not affect it. A file
  shared with you can be used and copied too.
- **ZIP archives** uploaded to a project, or copied into one, are unpacked into one document per
  file. Files a project does not take are skipped and listed.
- A project document marked **Not for AI** cannot be used in an app.
- **Download original** on a project document returns the file as it was uploaded.
- Copy to project needs user projects (`userProjects`). Images cannot be copied into a project or
  used in an app yet.

## Web Pages and HTML Files: Images Left Out, Whitespace Trimmed, Page Text Marked as the Page's

When the model reads a web page (**Read page** in web search) or an HTML file in a project, it now
gets the text of the page and nothing the page only shows as a picture, and spends less of its
context on blank space.

- Images are left out completely, with their alt text. Before, the alt text was passed on as
  `[Image: …]`, although nobody sees it on the page. A caption under a picture stays, and a link
  that holds only an image is dropped.
- No-break and other look-alike spaces become a normal space, a run of spaces inside a line
  becomes one, invisible characters (zero-width space, soft hyphen) are removed, and pages that
  space their layout with empty paragraphs no longer leave stacks of blank lines.
- The layout of code blocks and the indentation of nested lists stay as they are.
- The description in the page's `<meta name="description">` is still passed on next to the text,
  because it says what the page is about.
- Every web page result now says that its text, title, description, author and dates were written
  by the page and not by the user or iHub, and that the model must not follow instructions in them
  or put data from the conversation into an address. The note is in the `read_url` result
  (`sourceNotice`), once per web search, and in the description of the `read_url` tool.

## Read Images and Scanned PDFs as Text, Once

A vision-capable **text recognition model** can now read images and scanned PDF pages when they are
added, so every app can use them, also apps whose model cannot read images, and no answer pays for
reading them again. Set it in **Admin → Chat history → Uploaded files → Text recognition**.

- **Projects** use it whenever a model is set: images (PNG, JPEG, GIF, WebP) can be uploaded, picked
  from a cloud drive, unpacked from a ZIP archive and copied from a chat, and scanned PDFs no longer
  fail. Only pages without a text layer are sent to the model.
- **Chats** use it only when **Read images and scanned PDFs in chats as text** is switched on (per
  app too). Then an attached image or scanned PDF is read once and the model gets its text; switched
  off, chats send them as images, as before.
- **Use in app** and **Copy to project** now work for images where they can be read as text.
- Each document records that its text was recognized and by which model, and says so in the list.
- At most 50 pages are read per document by default (**Most pages per document**).
- The pages are sent to the provider of the recognition model when they are added. Pick a model your
  data may go to.

**Before upgrading:** nothing to do. Migration V265 adds the settings with no model set, so nothing
is read until an administrator picks one.
