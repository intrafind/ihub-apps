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
it is now external: with the external default set to `always`, every page read is asked for. With
no external default, nothing changes.
