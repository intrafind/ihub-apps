# Features — Unreleased

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
  the text as Word shows them, so sections can be cited by number; a numbering Word feature that is
  not supported leaves the paragraph without a number rather than with a wrong one
- PDF files carry a `[Page N]` marker per page (with the printed page number when it differs, as
  in front matter numbered `i`, `ii`), keep their lines instead of one run of words, and flag
  pages without a text layer; scanned PDFs are still sent as page images
- Headers and footers of Word files (letterhead, document numbers, confidentiality notes) appear as
  `[Header] …` and `[Footer] …` lines before the text, without page numbers

Admins can switch this off under **Admin → Features → Structured document extraction** (on by
default); the previous plain text extraction then applies after users reload the page. If the
structured extraction fails for a file, the plain text is used and the upload still works. Apps
whose prompts relied on the flat text format can use the switch while they are adapted. See
[File Upload](../../file-upload-feature.md#extracted-text-format).
