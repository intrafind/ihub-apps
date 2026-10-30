---
name: files
description: Create downloadable files on demand — source code (JavaScript, TypeScript, Python, Java, SQL, shell scripts, CSS, …), JSON, YAML, CSV, Markdown, plain text — and pack several files or a whole project into a ZIP archive. Use whenever the user asks for a file, a script, a config file, a dataset, a code project, or "everything as a ZIP".
metadata:
  author: IntraFind
  version: '1.0'
allowed-tools: create_file create_zip
---

# Creating files and ZIP archives

You hand the user files with two tools. The user gets a download card in the chat for each one, and finds every file of the chat in its artifacts.

- **`create_file`** — one text file: `name` (with extension, optionally with folders) and its complete `content`.
- **`create_zip`** — one ZIP archive: new files in `files`, files you already created in this chat by name in `include`, or all of them with `includeAll: true`.

## When to use which

- **One or two files** → `create_file` for each one.
- **A project or many files** (more than about five) → one `create_zip` call with all files in `files`. This keeps the chat readable and avoids one card per file.
- **"Give me everything as a ZIP"** after you created files earlier → `create_zip` with `includeAll: true` (or `include` with the names the user wants). Do not write the files again.
- **Word, PDF or PowerPoint** documents are not text files: use the `docx`, `pdf` or `pptx` skill if available.

## Names and folders

- The **extension decides the file type**: `app.py`, `schema.json`, `data.csv`, `notes.md`, `query.sql`, `deploy.sh`. Use the conventional name for files without extension (`Dockerfile`, `Makefile`).
- Use **folders** for projects: `src/index.ts`, `src/components/Button.tsx`, `tests/test_app.py`, `README.md`. They are kept in the ZIP.
- Paths are relative. `..`, drive letters and leading slashes are removed.
- A file with the same name as an earlier one is a new version; `includeAll` packs the newest one.

## Content

- Write the **complete** file. No placeholders like `// rest of the code here` unless the user asked for a skeleton.
- Valid syntax for the type: JSON must parse (no comments, no trailing commas), YAML must be indented with spaces, CSV needs a header row and quotes around values that contain the separator.
- End text files with a newline.
- Only text: you cannot create images, binaries or office documents with these tools.

## Answer

After the tools ran, answer briefly: name the files (or the archive and its main files), and say how to use them (for example how to run the project). Do not paste the full content again, and do not add a link: the download cards are already there. Short snippets that explain something are fine.

If a tool returns an error, read it: it names missing files, limits (number of files, total size) or invalid names. Fix the call and try again.
