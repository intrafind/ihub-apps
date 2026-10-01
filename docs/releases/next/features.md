# Features — Unreleased

## PDF Documents on Demand: the `pdf` System Skill

The model can now create PDF documents in a chat, such as reports, invoices, letters, one-pagers
and checklists. The user gets a download card below the answer. PDFs are rendered on the server,
without Python or a browser.

- Enable it per app: turn on **Skills** in **Admin → Features**, then add the `pdf` skill to the
  app.
- Documents can have headings, tables, lists, callouts, columns, SVG charts, QR codes, a cover
  page, a table of contents, running headers and footers, page numbers and a watermark. Three
  themes are available, plus the brand colour.
- Models that can see images can look at a page of their PDF and correct the layout before they
  answer.
- `pdf` is a **system skill**: it ships with iHub and is updated with it, and it shows a
  **System** badge in **Admin → Skills**. It cannot be changed or deleted there, and its name is
  reserved: a skill with the same name is ignored or refused on import.
- A PDF is kept like a generated image: a stored chat keeps it with the answer, deletes it with
  the chat and includes it in a share of the chat.
- Editing, merging or filling in PDFs the user uploaded is not supported yet.
