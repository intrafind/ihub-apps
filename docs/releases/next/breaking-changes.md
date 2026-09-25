# Breaking Changes — Unreleased

## MCP Servers: A Blank Tool Prefix Now Means `<id>__`

An MCP server saved from **Admin → MCP servers** with the **Tool prefix** field left empty exposed
its tools with no prefix at all (`create_diagram` instead of `drawio__create_diagram`), although
the field showed `<id>__` as its default. Tools of two servers could end up with the same name.
A blank prefix now gets the default, and the upgrade removes the stored empty prefix.

- Tool ids of such servers change, e.g. `create_diagram` becomes `drawio__create_diagram`.
- The upgrade switches apps that listed single tools of an MCP server over to the server itself,
  so they keep their tools: `drawio__create_diagram` becomes `drawio`, and so does a bare
  `create_diagram` when the server's **Tools offered to apps** names it.
- A bare tool name the upgrade cannot tie to one server — the server offered all its tools — is
  left in the app and reported in the server log. It no longer does anything, and users do not
  see it.
- A prefix an admin typed is kept.

**Before upgrading:** No action is needed beforehand. After the upgrade, check the server log for
apps reported by migration V134: tick the named MCP server under **MCP servers** in each of them
and remove the reported tool names from **Tools**. Anything else that names these tools directly,
such as a workflow node, needs the new tool ids.

## Outlook Add-in: The Pinned Pane Follows the Open Email on Mac; Multi-Select Removed

On Outlook for Mac, the pinned iHub pane stayed on the email it was opened on. Clicking another
email refreshed the pane but showed the same email again, and only closing and reopening the pane
picked up the new one. The add-in manifest declared support for selecting several emails at once,
and with that declaration Outlook for Mac never tells the add-in that the open email changed. The
manifest no longer declares it.

- On every Outlook client the pinned pane now switches to the email you open, with one refresh.
  Keep the pane pinned and click through your emails to collect several with **Add email(s)**,
  one at a time.
- Ctrl-selecting several emails and adding them in one go is no longer offered. It needed full
  mailbox access, which the add-in never requested, so it did not work in any installation.

**Before upgrading:** No action is needed beforehand. After the upgrade, deploy the manifest from
**Admin → Office Integration → Office Manifest** again (in the Microsoft 365 admin center, or by
re-adding it in Outlook for a sideloaded add-in). Until then, Outlook keeps the old manifest and
Mac users keep seeing the old behaviour.
