# Fixes — Unreleased

## Skills and Marketplace Previews Read Front Matter as YAML Only

The metadata block at the top of a `SKILL.md` file — its front matter — is now always read as
YAML, as the Agent Skills format specifies. A block that names another format after the opening
`---` (for example `---json`) is no longer interpreted.

- A skill whose front matter names another format is skipped when skills load, and the server log
  names the file. Importing such a skill in **Admin → Skills** fails with "Failed to parse
  SKILL.md".
- In the marketplace, the preview of such an item is shown as plain text instead of a metadata
  table.
- Skills with plain YAML front matter, including every skill shipped with iHub, are unaffected.
