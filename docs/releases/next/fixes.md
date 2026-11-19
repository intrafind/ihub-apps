# Fixes — Unreleased

## Tool Approval: the Page Reader Counts as an External Tool

The page reader (`read_url`) was treated as an internal tool, so the platform default for external
tools (`toolApproval.defaults.external`, **Admin → Security → Tool approval**) did not apply to it,
and its approval card said "Internal". A page address can carry data from the chat to any host, so
it is now external: with the external default set to `always`, every page read is asked for. With
no external default, nothing changes.
