# Breaking Changes — Unreleased

## MCP Servers: A Blank Tool Prefix Now Means `<id>__`

An MCP server saved from **Admin → MCP servers** with the **Tool prefix** field left empty exposed
its tools with no prefix at all (`create_diagram` instead of `drawio__create_diagram`), although
the field showed `<id>__` as its default. Tools of two servers could end up with the same name.
A blank prefix now gets the default, and the upgrade removes the stored empty prefix.

- Tool ids of such servers change, e.g. `create_diagram` becomes `drawio__create_diagram`.
- Apps that enable the server as a whole (**MCP servers** section of the app editor) are not
  affected.
- Apps that listed the server's tools one by one under their old names no longer find them.
- A prefix an admin typed is kept.

**Before upgrading:** No action is needed beforehand. After the upgrade, open each app that uses
one of these servers, tick the server under **MCP servers**, and remove leftover tool names from
the **Tools** section. The same applies to anything else that names these tools directly, such as
workflow nodes.
