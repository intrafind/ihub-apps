# Server-side PDF Generation and System Skills

Issue: [intrafind/ihub-apps#2635](https://github.com/intrafind/ihub-apps/issues/2635) (analysis and
plan) · PR: [intrafind/ihub-apps#2639](https://github.com/intrafind/ihub-apps/pull/2639) · Also
fixes [intrafind/ihub-apps#2062](https://github.com/intrafind/ihub-apps/issues/2062) (blank PDF
exports). Admin and developer documentation: [`docs/pdf-generation.md`](../docs/pdf-generation.md).

## Goal

PDFs are generated on the server, for two uses:

1. **The model creates a PDF on demand** (a report, an invoice, a letter) through a skill.
2. **Exports produce real PDF files.** Chat export and the Markdown download menus used to open
   the browser's print dialog, which printed blank pages in the Outlook task pane, the browser
   extension and some browsers.

The skill is a **system skill**: shipped and updated with iHub, not editable by admins. DOCX, PPTX
and XLSX system skills will follow the same model.

## Starting point

The skill we were given is a Python skill for a code sandbox: reportlab to write, pypdf and poppler
to inspect, the model writing and running Python. iHub has no code sandbox, the production image is
Alpine with Node only, and there is no Chromium for HTML-to-PDF. Its value is in the layout
guidance (structure, typography, tables, charts, a review loop), not in the runtime.

## Decisions

### Engine: pdfmake on pdfkit, no Python, no browser

| Option | Verdict |
| --- | --- |
| Python sandbox (the original skill) | No sandbox, no Python in the image; running model-written code is a large new attack surface. |
| Chromium (Puppeteer) HTML-to-PDF | Not in the Alpine image; ~300 MB and a browser process per render. |
| pdf-lib alone | Low-level drawing only: no text flow, tables or page breaks. |
| **pdfmake** (MIT, pure JS, on pdfkit) | Declarative document model with flowing text, tables with spans, columns, TOC, headers and footers, SVG, QR. Chosen. |

Fonts are DejaVu Sans, Serif and Mono from npm, embedded from memory. `pdf-lib` (already a
dependency) re-reads every output, and `@hyzyla/pdfium` (already a dependency) renders page
previews for the model.

### Input: Markdown plus allowlisted layout blocks

The model writes Markdown (the `marked` lexer, converted to pdfmake nodes) and, only where Markdown
cannot express a layout, **layout blocks**: an allowlisted JSON subset of pdfmake (columns,
callouts, boxes, tables with spans, SVG, canvas shapes, QR codes, TOC). Unknown keys and invalid
values are dropped and reported as warnings. `blocks`, `styles` and `images` are tool parameters of
type string (JSON text): the blocks are alternatives with one content key each, and providers with
a strict schema mode would otherwise make every key of every block required.

### Isolation and limits

Every render runs in a worker thread with a time budget (45 s, 90 s for exports), a 512 MB heap
cap, at most two concurrent renders and 20 queued. Limits cover layout elements (50,000), images
(5 MB each, 15 MB per document), pages (500) and Markdown length (2,000,000 characters, refused up
front for exports).

### Security

- pdfmake's local-file and URL access policies deny everything; fonts come from an in-memory file
  system. Attachments and file specs are removed from the document definition.
- Images are only PNG/JPEG `data:` URIs whose bytes match their declared type.
- SVG is parsed strictly as XML (`xmldoc`) and rebuilt without scripts, foreign content, event
  handlers, comments and `@import`. Every link attribute (`href`, `xlink:href`, any prefix) is
  checked: an `<a>` keeps only `http(s)`/`mailto` targets, an `<image>` only inline PNG/JPEG, and
  everything else only local `#id` references. svg-to-pdfkit's image callback is replaced as a
  second layer.
- Links in the document are `http(s)` or `mailto` only. Colours are hex or one of the 147 names
  pdfkit knows.

### System skills

- Live under `server/systemSkills/<name>/`. `isSystem` comes from that location only, never from
  frontmatter. They are never copied into `contents/`.
- Names are reserved: a same-named `contents/skills/<name>` is ignored with a warning; admin
  delete, zip import and marketplace install over the name are refused.
- A system skill's `allowed-tools` names built-in tools registered in
  `server/services/systemSkillTools.js`, which come with the skill when an app enables it. Installed
  skills cannot enable tools. The usual gates apply: the `skills` feature, the app's `skills` and
  the user's `permissions.skills`.
- Skill access is now checked: `activate_skill`, `read_skill_resource` and slash-command
  pre-activation only load a skill the app enables and the user may use.

### Generated files: the path generated images already take

No download route, storage scope or sweep of their own:

1. `create_pdf` holds the PDF in a bounded in-memory area (`generatedFiles.js`: one hour, 50 files,
   200 MB) and returns only a descriptor, so the model never sees the bytes.
2. The chat tool seam streams the bytes on `tool/completed`; only system skill tools may hand over
   files. The chat shows a download card.
3. The materializer stores them with the answer as `document` artifacts of the chat (the kind
   already allowed `application/pdf`). After a reload the card fetches them from
   `GET /api/chats/:chatId/artifacts/:artifactId`; a share includes them through the share's
   artifact route; they are deleted with the chat. Storage follows `platform.artifacts`.
4. A chat that is not stored keeps the file as long as the page. sessionStorage never holds the
   bytes.

`preview_pdf` reads from the same in-memory area (same user and chat).

### Server-side export

`POST /api/exports/pdf` renders `kind: chat | markdown` from what the client sends, stores
nothing, and is rate limited (30 per minute). Chat exports follow the `export` feature of the
platform and, when the request names one, of the app. That app check mirrors the UI: it is not an
access boundary, because the content is the caller's own and the same chat is downloadable as
JSON, Markdown or HTML entirely in the browser. The dialog's defaults come from
`platform.pdfExport`.

## Code

| Area | Location |
| --- | --- |
| Engine | `server/services/documents/pdf/` (`buildDocument`, `markdownToPdfmake`, `sanitizeBlocks`, `validators`, `themes`, `fonts`, `glyphs`, `renderPdf`, `pdfWorker`, `PdfService`) |
| Tools | `pdfToolDefinitions.js`, `pdfTools.js`, `server/services/systemSkillTools.js` |
| Skill | `server/systemSkills/pdf/` (`SKILL.md`, `references/layout-blocks.md`, `references/examples.md`) |
| Generated files | `server/services/documents/generatedFiles.js`, `shared/generatedFiles.js`, `server/services/chat/chatSeams.js`, `chatMaterializer.js`, `client/src/features/chat/components/GeneratedFiles.jsx` |
| Export | `server/services/documents/ExportService.js`, `server/routes/exports.js`, `client/src/api/endpoints/exports.js` |
| System skills | `server/services/skillLoader.js`, `server/toolLoader.js`, `server/routes/admin/skills.js`, `server/services/marketplace/ContentInstaller.js` |
| Tests | `server/tests/pdf-engine.test.js`, `server/tests/system-skills.test.js` (`npm run test:pdf`) |

## Not yet

- Operating on PDFs the user uploaded (merge, split, fill forms, extract): the server never
  receives the original bytes today.
- Encryption, and referencing uploaded images from `create_pdf`.
- System skill tools inside workflow and agent nodes.
- Canvas "Print as PDF" and the Mermaid PDF export.
- The DOCX, PPTX and XLSX system skills.
