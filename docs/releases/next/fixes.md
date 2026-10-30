# Fixes — Unreleased

## Chat: Code Block Download Names, Translated Feedback and Clean Copies

Three small problems with the code blocks in answers are fixed:

- **Download name:** a code block that names its file (` ```js title="src/index.js" `, or
  ` ```python:app/main.py `) now downloads under that name. Before, every download was called
  `code.<extension>`, and such a block also lost its syntax highlighting and showed the whole
  line, `JS TITLE="SRC/INDEX.JS"`, as its language.
- **Feedback in your language:** "Copied!", "Downloaded!" and "Error" on the code block buttons
  now follow the interface language instead of always being English.
- **Clean copies:** selecting an answer and copying it no longer brings along the language label
  and the "Copy" and "Download" button labels of its code blocks or the diagram controls.
