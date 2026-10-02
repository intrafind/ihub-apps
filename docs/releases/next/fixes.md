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
- 
## Diagram Rendering Is Stricter About Untrusted Content

Mermaid diagrams in chat answers, pages and other Markdown content now render with Mermaid's
strict security level. The drawn diagram, its fullscreen view and the error shown for a diagram
that cannot be drawn are sanitized before they appear in the page; diagram source in the error
view is shown as plain text. Only diagrams written as Mermaid code blocks are drawn, and markup in
the content that merely looks like a diagram is left as it is. Diagrams look the same as before.

## Themed Mermaid Diagrams Render for Every Diagram Type

Pie charts, Gantt charts, mind maps and several other diagram types showed "Incomplete diagram
code." instead of the diagram when they started with Mermaid theme settings (a `config:` front
matter block or an `%%{init: ...}%%` directive). These diagrams now render with their colors, so
an app's system prompt can ask the model to apply a corporate color palette to any diagram type.

## Sign-In Returns Only to Pages of This Installation

After signing in, users are sent back only to a page of this iHub installation. A return address
that points anywhere else — another site, or a link that is not a web page — now opens the home
page instead.

- Applies to the login page, single sign-on (OIDC, NTLM) and signing in again after a session
  expired.
- On installations served under a subpath (for example `/ihub/`), the return address must also
  lie under that path.
