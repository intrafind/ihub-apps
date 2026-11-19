# Fixes — Unreleased

## My Skills: Version History Only for Owners and Editors

Anyone a personal skill was shared with could read all of its earlier versions, including text
the owner had removed before sharing it. The history is now limited to the owner and to people
the skill is shared with for editing, as it already was for prompts. Everyone else can still use
the current version.

## Tool Approval: the Page Reader Counts as an External Tool

The page reader (`read_url`) was treated as an internal tool, so the platform default for external
tools (`toolApproval.defaults.external`, **Admin → Security → Tool approval**) did not apply to it,
and its approval card said "Internal". A page address can carry data from the chat to any host, so
it is now external: with the external default set to `always`, every page read is asked for. It is
also declared a read, so `writes` (for external tools or as the general default) no longer asks for
page reads, as it did while the page reader's side effect was unknown. An app that sets `writes` for
`read_url` (by tool id, by installation or as its app default) no longer asks for page reads either.
With no approval default on the platform or the app, nothing changes.
