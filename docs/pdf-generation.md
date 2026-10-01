# PDF Generation and System Skills

iHub generates PDF files on the server, without Python and without a browser. The same engine serves two purposes:

1. **On demand by the model.** The **`pdf` system skill** lets the model create a PDF document in a chat — a report, an invoice, a letter, a one-pager. The user gets a download card below the answer.
2. **Exports.** Chat export, the Markdown download menus (workflow output) and agent artifacts produce a real `.pdf` file. They used to open the browser's print dialog, which printed blank pages in the Outlook task pane, the browser extension and some browsers.

## System skills

A **system skill** is a skill that ships with iHub, as part of the server (`server/systemSkills/<name>/`). It works like any other [skill](concepts.md#skills): a `SKILL.md` with instructions, plus reference files the model reads when it needs them.

What makes it different:

- **Read-only.** Admins cannot edit, overwrite or delete a system skill. It is never copied into `contents/`, and it is updated together with iHub. In **Admin → Skills** it carries a **System** badge. The detail page shows what it does and which tools it brings, without edit, toggle or delete actions.
- **Reserved name.**
  - A folder `contents/skills/<name>` with the same name is ignored; the server logs a warning.
  - Importing a skill zip or installing a marketplace skill under that name is refused.
- **Location, not metadata.** A skill is a system skill because of where it lives. An `isSystem` field in the frontmatter of an uploaded skill has no effect.
- **It can bring tools.** A system skill names built-in tools in its `allowed-tools` frontmatter. When an app enables the skill, the model gets those tools as well. A skill an admin installs cannot enable tools this way.

System skills follow the same rules as every skill:

- The **Skills** feature must be on (**Admin → Features**).
- The app must list the skill (**Admin → Apps → Skills**, or `"skills": ["pdf"]` in the app config).
- The user must be allowed to use it (`permissions.skills` in [groups](platform.md)).

Nothing changes for an app that does not list the skill.

The shipped system skills:

| Skill | Tools | Purpose |
|---|---|---|
| `pdf` | `create_pdf`, `preview_pdf` | Create PDF documents on request |

Further system skills for Word, PowerPoint and Excel documents are planned on the same infrastructure.

### Skill access checks

Skill activation checks access. `activate_skill` and `read_skill_resource` only load a skill that the app enables and the user may use. The same check covers pre-activating a skill with a slash command. Workflow and agent nodes keep choosing their skills on the node or profile.

## The `pdf` skill

### Enabling it

1. Turn on **Skills** in **Admin → Features**.
2. Add `pdf` to the app's skills (**Admin → Apps → edit app → Skills**).
3. Check that the user's groups may use the skill. The default `users`, `authenticated` and `admins` groups allow all skills.

The model then sees the skill in `<available_skills>`, can load its instructions with `activate_skill`, and can call `create_pdf`.

### What the model can do

`create_pdf` renders a document from **Markdown**, optionally followed by **layout blocks** for layouts Markdown cannot express. It also sets the document up:

- **Content:** headings, paragraphs, bold/italic/strikethrough, links, nested and task lists, GFM tables with column alignment, code blocks, quotes, horizontal rules, `<sub>`/`<sup>`, page breaks (`\pagebreak`), and images as `data:` URIs.
- **Layout blocks:** columns, callouts (info/success/warning/danger/note), boxes, tables with merged cells and custom widths, SVG charts and diagrams, canvas shapes, QR codes, named styles.
- **Document settings:**
  - title, subtitle, author, language
  - theme (`default`, `professional`, `minimal`) and brand colour
  - font family and size, page size and orientation, margins
  - running header and footer, page numbers
  - cover page, table of contents, watermark

`preview_pdf` renders one page of a PDF the model created to an image and shows it to the model. The model can then check the layout and correct it, which is the "render it and look at it" step of the skill. It is only offered to models that accept images (`supportsImages`).

The skill's instructions and references are in `server/systemSkills/pdf/`:

- `SKILL.md`: workflow and print layout rules.
- `references/layout-blocks.md`: the full block grammar.
- `references/examples.md`: complete report, invoice, letter and one-pager.

### What it cannot do (yet)

- **Edit, merge, split, fill in or extract from PDFs the user uploaded.** Uploaded documents are converted to text in the browser, so the server never has the original file. The skill tells the user so and offers to create a new document instead.
- **Colour emoji and CJK text.** The bundled fonts (DejaVu Sans, Serif and Sans Mono) cover Latin, Greek, Cyrillic and a wide range of symbols (arrows, check marks, box drawing).
  - Common colour emoji are replaced by their monochrome counterparts (✅ becomes ✔).
  - Anything the fonts cannot draw is left out, and the tool reports it as a warning.
- **Remote images.** Images must be inline `data:` URIs. The renderer never fetches URLs.

### Generated files

A file the model created takes the path a generated picture takes. There is no download route of its own:

- **While the answer streams:** `create_pdf` keeps the PDF in server memory and returns only a descriptor, so the model never sees the bytes. The bytes reach the chat with the tool's `tool/completed` event, and the download card below the answer saves them.
- **Stored with the answer:** in a durable chat, the PDF is stored as a `document` [artifact](artifacts.md) of the chat. After a reload, the card downloads it from `GET /api/chats/:chatId/artifacts/:artifactId`. It is deleted with the chat, and a [share](chat-sharing.md) of the chat includes it.
- **Chats that are not stored:** the file lives as long as the page, like a generated picture. After a reload, the card says it is no longer available.
- **Limits:**
  - 25 MB per file.
  - Storing follows the artifact settings (`platform.artifacts`: `maxBytes`, default 10 MB, and `maxPerBatch`). A file over the cap is still downloadable while the answer is on screen; its stored card says it was not kept.
- **Preview:** `preview_pdf` reads the PDF from the server's memory. That works for PDFs created in the same chat within the last hour.

## Server-side PDF export

`POST /api/exports/pdf` renders a PDF and returns it as the response (`Content-Disposition: attachment`). Nothing is stored.

| `kind` | Body | Used by |
|---|---|---|
| `chat` | `messages` (`role`, `content`, `timestamp`), `settings`, `title`, `appName`, `appId`, `template`, `watermark`, `language`, `timeZone`, `filename` | Chat export dialog, single-message download |
| `markdown` | `markdown`, `title`, `template`, `language`, `filename` | Workflow output download menu, agent artifact downloads |

- **Templates:** `default`, `professional` and `minimal`, the same names the export dialog has always offered.
- **Watermark:** a small label at the bottom left, centre or right of every page, with the chosen opacity.
- **Defaults:** [`platform.pdfExport`](platform.md#pdfexport) supplies the export dialog's default template and watermark, and the server's default when a request sends none.
- **Access:**
  - Chat exports follow the **Export** feature (platform) and the app's `features.export`.
  - Markdown exports are plain downloads and were never behind that switch.
- **Limits:**
  - Chat exports: 2,000 messages and 8 million characters.
  - Rate limit: 30 exports per minute per client.

The PDF export is the base the planned signed exports build on (EU AI Act content marking).

## How rendering works

- **Engine:** [pdfmake](https://pdfmake.github.io/) (MIT, pure JavaScript, on top of pdfkit) lays out and renders the document.
  - [pdf-lib](https://pdf-lib.js.org/) re-reads every result as a validity check.
  - pdfium (WASM) renders the page previews.
  - No Python, no Chromium and no system packages are needed, so it works in the Alpine Docker image and in the single-binary build.
- **Isolation:** each document is laid out and rendered in its own **worker thread**:
  - 45-second time budget (90 seconds for exports)
  - 512 MB memory cap
  - at most two documents at once per server process, and up to 20 waiting
  - A pathological layout fails with an error; it never blocks the server.
- **Untrusted layouts:** model-authored layout blocks pass an allowlist sanitiser.
  - Every node type and property is checked; unknown ones are dropped with a warning.
  - Images must be PNG/JPEG `data:` URIs whose bytes match their type.
  - SVG loses scripts, foreign objects and external images; the SVG renderer's image loader only accepts `data:` URIs as well.
  - Links must be `http(s):` or `mailto:`. Fonts are limited to the bundled families.
  - Size limits: 50,000 layout elements, 5 MB per image, 15 MB of images per document, 500 pages.
  - The renderer's file and URL access policies deny everything. Fonts are loaded from memory.

## Adding a system skill (developers)

1. Create `server/systemSkills/<name>/SKILL.md` (frontmatter `name`, `description`, `allowed-tools`), plus `references/` as needed.
2. Define the tools as plain data (compare `server/services/documents/pdf/pdfToolDefinitions.js`) and register them in `server/services/systemSkillTools.js`, with a handler that is loaded when the tool runs.
3. A tool that produces a file holds it with `holdGeneratedFile()` (`server/services/documents/generatedFiles.js`) and returns the descriptor in `files`. The chat streams the bytes to the download card and stores the file as a `document` artifact with the answer. Add the file's media type to `GENERATED_FILE_TYPES`, to `shared/generatedFiles.js` and, if it is new, to the `document` kind in `server/services/artifacts/artifactPolicy.js`.
