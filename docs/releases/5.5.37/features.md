# Features — 5.5.37

## Uploaded Documents Keep Their Structure

Word documents (.docx) and PDF files now reach the model with their structure instead of one run
of plain text, so prompts can refer to sections, tables, lists and pages, and comparisons can go
heading by heading.

- Headings keep their level — built-in headings, custom heading styles and paragraphs with a Word
  outline level — and paragraphs, lists, footnotes and links stay separate and readable
- Tables become Markdown tables; merged cells keep their columns
- Explicit page breaks appear as `[Page break]` (Word stores no page numbers); images appear as
  their alt text, never as embedded data
- Hidden text is no longer sent to the model, and text that was moved with track changes appears
  once, at its new position
- Chapter and list numbers from Word's numbering (`2.1`, `a)`, `(iii)`, `§ 3`) are written in front of
  the text as Word shows them, so sections can be cited by number; a level with a custom restart
  rule gets no number rather than a possibly wrong one
- PDF files carry a `[Page N]` marker per page (with the printed page number when it differs, as
  in front matter numbered `i`, `ii`), keep their lines instead of one run of words, and flag
  pages without a text layer; scanned PDFs are still sent as page images
- PDF headings and tables are marked where the file tells where they are: tagged PDFs (exported
  from Word, LibreOffice, InDesign and others) give `#` headings and Markdown tables, otherwise the
  outline (bookmarks) or clearly larger type marks headings. Nothing is guessed when the picture is
  unclear, and no text is dropped or reordered
- Apps for contract review and comparison can opt in to Word's review marks under **Admin → Apps →
  Upload Configuration**: tracked changes as `{++added++}` / `{--removed--}` and comments as
  `{>>Author: text<<}` after the text they belong to. Both are off by default — the model still
  reads the accepted view without comments — and the settings only affect the app they are set in
- The OpenAI-compatible API reads files the same way: PDFs with page markers, headings and tables,
  and Word (`.docx`) files, which were refused before, as Markdown — so an integration that sends
  contracts through the API sees what the chat sees. The one difference: a scanned PDF without a
  text layer is not read through page images as in the chat; the API answers `file_has_no_text`,
  and the caller sends the pages as `input_image`
- PowerPoint decks (.pptx) are read in the order of the presentation (a moved slide used to keep
  its old number), with the slide title as a heading, tables as Markdown tables and hidden slides
  flagged; speaker notes are sent only for apps that opt in (**Admin → Apps → Upload
  Configuration → PowerPoint: speaker notes**). The API accepts decks too
- Excel sheets with a header row become Markdown tables, merged cells keep every row complete and
  hidden sheets are flagged. A spreadsheet can no longer fill the context window on its own: at
  most 2,000 rows per sheet and 300,000 characters per workbook are sent, and what was left out is
  said
- Headers and footers of Word files (letterhead, document numbers, confidentiality notes) appear as
  `[Header] …` and `[Footer] …` lines before the text, without page numbers
- LibreOffice and OpenOffice files read like their Microsoft counterparts: texts (.odt) with
  headings, the list and chapter numbers Writer shows, tables, footnotes and links; spreadsheets
  (.ods) as tables with the same limits as Excel; presentations (.odp) as slides, with speaker
  notes for apps that opt in. Where the numbering of a list cannot be reproduced with certainty,
  the item gets no number rather than a wrong one. The API accepts these files too

Admins can switch this off under **Admin → Features → Structured document extraction** (on by
default); the previous plain text extraction then applies after users reload the page. If the
structured extraction fails for a file, the plain text is used and the upload still works. Apps
whose prompts relied on the flat text format can use the switch while they are adapted. See
[File Upload](../../file-upload-feature.md#extracted-text-format).

## API Key Status for Models and Providers

A key that is stored but cannot be read used to look like a missing one. When the server's
encryption key is not the one a key was saved with — several instances without a shared
`TOKEN_ENCRYPTION_KEY`, or a lost `contents/.encryption-key` — chat failed with "API key not found"
although a key was set, and nothing said why.

- **Admin › Models** has an **API key** column and the model editor shows the status under the key
  field. **Admin › Providers** shows it for LLM providers instead of a plain "Configured".
- The states are **Key found** (and where it comes from: the model, its provider or an environment
  variable), **No key needed**, **No API key** and **Stored key unreadable**.
- A stored key that cannot be decrypted is reported as such, in the status, in the model test and
  to chat users, who see a message that an administrator has to enter the key again. The server log
  names the cause.
- A key from the environment still wins over an unreadable stored one.
- The last step of the setup guide says how many enabled models are ready to use and links to the
  models when some still lack a key. Choosing a cloud provider now points to **Local Provider** and
  to skipping the step for those who have no key yet.

If you run more than one instance, set the same `TOKEN_ENCRYPTION_KEY` on all of them.

## Scheduled Tasks Can Remember Between Runs

A scheduled task can now keep notes between its runs and look at its earlier runs, so a weekly "what
are the latest features of …?" reports only what is new instead of the same summary every week. It
is opt-in per task: tick **Remember between runs** on the task form.

- At the start of a run, the task reads its notes and its last successful run, then reports only
  what is new or changed. After a successful run, its notes are updated automatically — the model
  does not have to remember to write them.
- The **Memory** card on the task page shows the notes, and the owner can edit or clear them. If a
  run changes the notes while you are editing, the editor says so instead of overwriting them.
- **Notify me → Only when something changed (and on failures)** keeps a quiet week quiet: a run
  that found nothing new creates no notification. Failed runs always notify.
- Notes are private to the task's owner. Admins see only their size, version and last update, and
  can clear them, in Admin → Scheduled Tasks.
- Turning memory off keeps the notes; duplicating a task starts the copy with empty notes; deleting
  a task deletes its notes.
- New platform settings in Admin → Scheduled Tasks → Settings: `memoryEnabled` (default on),
  `memoryMaxChars` (default 8000) and `maxHistoryReadChars` (default 8000). Existing installations
  get them, and the new option in the scheduling tools, automatically on upgrade.
- Agents keep their memory exactly as before; tasks use the same memory tools and editor.

See [Scheduled Tasks](../../scheduled-tasks.md#memory-and-earlier-runs).

## Keyboard Access for Source, App and OCR Pickers

Three controls could only be used with a mouse. They now work from the keyboard as well:

- **Source picker** (used when attaching sources to apps and agents): each source row is a checkbox you can focus with Tab
  and toggle with Enter or Space.
- **OCR upload area**: focus it and press Enter or Space to open the file chooser, the same as
  clicking it.
- **Linked-app selector** for prompts: the options can be reached with Tab and chosen with Enter
  or Space.

Screen readers now announce these controls with their proper roles and selected state.

## Signed Build Provenance and SBOMs for Releases

Releases can now be checked before they are installed. Release binaries, the Nextcloud plugin and
the container image on GHCR carry signed build provenance, which proves they were built by the
iHub Apps release workflow from the tagged source. Each release also lists CycloneDX SBOMs of the
dependencies it ships, for vulnerability and license tracking.

- Check a download: `gh attestation verify <file> --repo intrafind/ihub-apps`.
- Check the image:
  `gh attestation verify oci://ghcr.io/intrafind/ihub-apps:<version> --repo intrafind/ihub-apps`.
- The image carries its own SBOM, shown by `docker buildx imagetools inspect`.
- Details: *Security → Automated Security Checks → Verifying a Release* in the documentation.
