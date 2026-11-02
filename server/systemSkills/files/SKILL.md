---
name: files
description: Create downloadable files on demand — source code (JavaScript, TypeScript, Python, Java, SQL, shell scripts, CSS, GraphQL, Prisma, Protobuf, …), JSON, YAML, CSV, Markdown, Jupyter notebooks (.ipynb), diagram source files (.drawio, .excalidraw, .mmd, .dot, .puml), calendar invites (.ics), contact cards (.vcf), plain text — and pack several files or a whole project into a ZIP archive. Use whenever the user asks for a code/config/data file, a notebook, a downloadable diagram source file, a multi-file project, or "everything as a ZIP".
metadata:
  author: IntraFind
  version: '1.2'
allowed-tools: create_file create_zip
---

# Creating files and ZIP archives

You hand the user files with two tools. The user gets a download card in the chat for each one, and can preview code, Markdown, JSON, CSV tables and Jupyter notebooks directly in the **Artifacts** panel.

- **`create_file`** — one text file: `name` (with extension, optionally with folders) and its complete `content`.
- **`create_zip`** — one ZIP archive: new files in `files`, files you already created in this chat by name in `include`, or all of them with `includeAll: true`.

## When to use which tool or skill

- **One or two code/config/data files** → `create_file` for each one.
- **A multi-file project** (more than about five files) → one `create_zip` call with all files in `files`. This keeps the chat readable and avoids one card per file.
- **"Give me everything as a ZIP"** after you created files earlier → `create_zip` with `includeAll: true` (or `include` with the names the user wants). Do not write the files again.
- **Interactive HTML dashboards, calculators, prototypes, or standalone `.svg` graphics** → use the `web-artifacts` skill (`create_web_artifact`) if available.
- **Office documents and PDFs** are binary packages, not plain text:
  - Formatted Excel workbooks with live formulas or multiple sheets → use `xlsx` (`create_xlsx`). Use `.csv` via `create_file` only for raw flat data exports.
  - Word documents → use `docx` (`create_docx`).
  - PDFs, forms, and print posters → use `pdf` (`create_pdf`).
  - PowerPoint decks → use `pptx` (`create_pptx`).

## Names and folders

- The **extension decides the file type**: `app.py`, `schema.json`, `data.csv`, `analysis.ipynb`, `architecture.drawio`, `board.excalidraw`, `invite.ics`, `contact.vcf`, `notes.md`, `query.sql`, `deploy.sh`. Use the conventional name for files without extension (`Dockerfile`, `Makefile`).
- For **Jupyter notebooks (`.ipynb`)**, **editable diagrams (`.drawio`, `.excalidraw`, `.mmd`, `.dot`, `.puml`)**, **calendar invites (`.ics`)** and **contacts (`.vcf`)**, read `references/formats.md` with `read_skill_resource` for exact schemas. (For quick diagrams in your reply when no file download was requested, use an inline ```` ```mermaid ```` block in chat.)
- Use **folders** for projects: `src/index.ts`, `src/components/Button.tsx`, `tests/test_app.py`, `README.md`. They are kept in the ZIP.
- Paths are relative. `..`, drive letters and leading slashes are removed.
- A file with the same name as an earlier one is a new version; `includeAll` packs the newest one.

## Content

- Write the **complete** file. No placeholders like `// rest of the code here` unless the user asked for a skeleton.
- Valid syntax for the type: JSON, `.ipynb` and `.excalidraw` must parse (no comments, no trailing commas), YAML must be indented with spaces, CSV needs a header row and quotes around values that contain the separator.
- End text files with a newline.
- Only text: you cannot create raster images, binaries or office documents with these tools.

## Answer

After the tools ran, answer briefly: name the files (or the archive and its main files), and say how to use them. Do not paste the full content again, and do not add a link: the download cards are already there. Short snippets that explain something are fine.

If a tool returns an error, read it: it names missing files, limits (number of files, total size) or invalid names. Fix the call and try again.
