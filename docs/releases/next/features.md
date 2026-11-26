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
- Text the page hides is left out: an element with the `hidden` attribute, or with an inline
  `display: none` or `visibility: hidden`, in any spelling (`DISPLAY:NONE` included). Pages
  without a clear article, such as short pages and listings, used to keep such text, and so did
  an article page when the property was written in capitals. Text hidden in other ways (by a
  stylesheet, or by size, position, opacity or colour) cannot be told from visible text this way
  and is still passed on.
- The description in the page's `<meta name="description">` is still passed on next to the text,
  because it says what the page is about.
- Every web page result now says that its text, title, description, author and dates were written
  by the page and not by the user or iHub, and that the model must not follow instructions in them
  or put data from the conversation into an address. The note is in the `read_url` result
  (`sourceNotice`), once per web search, and in the description of the `read_url` tool.

## MCP Gateway: Skills, Long Runs as Tasks and Approval Through the Client

The MCP gateway (`/mcp`) now speaks the MCP revision 2026-07-28 next to the 2025 revisions, and
supports three MCP extensions for the clients that declare them. Clients that do not keep working
as before.

- **2026-07-28 without sessions.** A client on the new revision needs no session: any worker and
  any replica answers its requests, with no affinity and no stateless mode to switch on.
- **Skills over MCP.** The skills a caller may use are served with `skills/list` and `skill://`
  files, each listed with its SHA-256 digest, so clients such as Claude Code can offer them and load
  them only when needed. Same switch and grant as the skill resources (`expose.resources`,
  `mcp:resources:read`, the group's skills).
- **Long runs as tasks.** An app or workflow called by a client that supports MCP Tasks returns a
  task handle at once; the client fetches the answer when the run is done instead of holding the
  request open. Tasks are kept 25 hours and only their owner sees them.
- **Approval through the client.** A tool that needs a person's approval is no longer refused
  outright: the gateway asks the person through their MCP client (elicitation) and runs the call
  once they approve.
- **Tool hints.** Integration actions carry MCP tool annotations (read-only, destructive) from
  their side effect.
- **Outbound:** iHub speaks 2026-07-28 to Streamable HTTP MCP servers that support it, and the 2025
  handshake to all others.

Details: [MCP Integration](../../mcp-integration.md#protocol-revisions).

## Document Templates: Colours and Fonts From the Word and PowerPoint Files

A document template that sets no colours of its own takes them from its Word and PowerPoint files,
so a template with just an upload already has a brand.

- **Where a colour comes from:** the template's own colour, else the PowerPoint theme, else the
  Word theme, else a neutral default. A Word document follows the Word template's theme first.
  Primary and accent colour are the first accents of the theme that are real colours, not greys;
  the text colour is the theme's dark 1.
- **Palette and fonts:** up to six palette colours and the theme's heading and body fonts are read
  from the files too. The tool descriptions tell the model the brand of the template that applies,
  read-only, with the fonts as names only: the reader's computer may not have them.
- **PDF margins:** PDFs take the page margins, the page size and the orientation of the Word
  template's last section, unless the template sets its own margins.
- **On the template page:** the colour fields show the colour the files give (with its source, such
  as "From the PowerPoint template") instead of a black swatch while nothing is set, and a picked
  colour stays. **Take colours from the PowerPoint/Word template** copies the colours of a file's
  theme into the fields. The palette and the heading and body font are shown read-only. The PDF
  margins show their source and prefill from the Word template; **Use the Word template's
  margins** takes your own values back.

## Word Templates: Year, Page Numbers, Table of Contents and Custom Fields

A Word template can hold more placeholders, written `{{name}}`, and the model asks the user for
what a template needs.

- **Built in:** `{{year}}` (the year of the document's date), `{{page}}` and `{{pages}}` (Word page
  number fields that keep the formatting of their text), and `{{toc}}`.
- **Table of contents:** a paragraph that holds only `{{toc}}` is where the contents go. The
  document gets one unless the model sets `toc: false`; without `{{toc}}` the contents stay an
  option at the start of the document. Word fills the contents when the file is opened and asks to
  update fields; other viewers show it empty.
- **Custom fields:** any other `{{name}}` (letters, digits, underscores) is a field of the
  template: a classification, a department, a document number. Declare them under `fields` in
  `contents/document-templates/<id>/template.json` with a label, a description, whether the field
  is required, the allowed values and a default. Uploading a Word template declares the
  placeholders it contains, and the **Fields** section of the template page edits them: a label, a
  description for the model, the allowed values, a default, "required", and a warning for a field
  the Word template no longer contains.
- **The model asks:** the Word tool lists the fields, passes their values in `fields`, and stops
  with `missing_fields` when a required value is missing or not allowed. The model is told to ask
  the user and never to invent a value. `edit_docx` changes one field and keeps the others.
- **Author:** the author of a Word document is the person who asked for it, unless the model names
  one.
