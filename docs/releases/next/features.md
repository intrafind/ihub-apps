# Features — Unreleased

## Uploaded Documents Keep Their Structure

Word documents (.docx) now reach the model as structured Markdown instead of one run of plain
text, so prompts can refer to sections, tables and lists, and comparisons can go heading by
heading.

- Headings keep their level — built-in headings, custom heading styles and paragraphs with a Word
  outline level — and paragraphs, lists, footnotes and links stay separate and readable
- Tables become Markdown tables; merged cells keep their columns
- Explicit page breaks appear as `[Page break]` (Word stores no page numbers); images appear as
  their alt text, never as embedded data
- Hidden text is no longer sent to the model, and text that was moved with track changes appears
  once, at its new position
- Chapter numbers from Word's numbering, headers and footers and PDF page markers follow in later
  updates

Admins can switch this off under **Admin → Features → Structured document extraction** (on by
default); the previous plain text extraction then applies after users reload the page. If the
structured extraction fails for a file, the plain text is used and the upload still works. Apps
whose prompts relied on the flat text format can use the switch while they are adapted. See
[File Upload](../../file-upload-feature.md#extracted-text-format).
