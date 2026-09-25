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
