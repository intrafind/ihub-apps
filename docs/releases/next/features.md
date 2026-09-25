# Features — Unreleased

## MCP Servers: Apps Use a Server as a Whole, Its Tools Are Chosen on the Server

An app now enables an MCP server as one unit, and users see it as a single entry in the chat's
**+** menu. Which of the server's tools exist is decided once, on the server, instead of in
every app.

- **Chat:** for every user and every MCP server, the **+** menu shows one toggle named after the
  server (e.g. "draw.io") and never the server's single tools. The server no longer shows up next
  to its own tools, as it did for the shipped draw.io Diagrams app.
- **Create app wizard:** MCP servers are offered as one entry each instead of tool by tool.
- **App editor:** the **MCP servers** section lists servers with a checkbox each; the individual
  tools are no longer shown there. Apps that picked a server's tools one by one keep working and
  are marked; turning the server off and on again switches them to the server's tool settings.
- **Admin → MCP servers:** **Tools offered to apps** chooses between all of a server's tools and
  a selection. After **Test connection** the tools are listed with checkboxes, and their long
  model-facing descriptions (draw.io's `create_diagram` runs to about 55,000 characters) are cut
  to two lines with **Show more**.

## Outlook Add-in: Install Dev and Production Side by Side

Every iHub installation used to serve the Outlook manifest with the same add-in ID and version,
so Outlook saw a second server as the add-in it already had: a dev instance could not be
installed next to production, and a re-deployed manifest was ignored.

- **Admin → Office Integration → Office Manifest** shows the add-in ID and a **Generate new ID**
  button. A new ID makes this server a separate add-in in Outlook; users of the old one must
  install the new manifest.
- Installations that never generate an ID keep the current one, so deployed add-ins keep working.
- The manifest version now follows the iHub release, so Outlook picks up a re-deployed manifest
  after every upgrade.
