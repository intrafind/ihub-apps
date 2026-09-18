# Breaking Changes — 5.5.10

## Outlook Add-in: email context is sent as tagged blocks

Messages from the Outlook task pane and the browser extension now wrap the source material in
tagged blocks — `<current_email>`, `<pinned_emails>`, `<current_meeting>`, `<current_page>` —
and the user's own note in `<user_instruction>`. The `--- Current email ---`,
`--- Pinned emails ---` and `--- Current meeting ---` headings are gone.

**Before upgrading:** nothing for the shipped apps — migration V108 rewrites the two meeting apps'
prompts. Custom app prompts that quote one of the old headings should be changed to the tag names
listed under "What the model receives" in the Outlook add-in guide.

## Admin → Feedback is a page of its own

The feedback review moved out of **Admin → Usage Reports → Feedback** into the new
**Admin → Feedback** page, which also carries the feedback settings. The Usage Reports tab is gone;
its average-rating tile links to the new page.

**Before upgrading:** nothing, unless your `contents/config/ui.json` hides Usage Reports with
`admin.pages.usage: false` to keep feedback entries out of the admin UI. That switch no longer
covers them — add `admin.pages.feedback: false` alongside it. Admin API access is unchanged either
way: both switches only decide what the admin UI shows.

## New MCP clients wait for an administrator's approval

A host in the trusted-client list now makes a client *eligible* to connect, not allowed. The first
time somebody adds a connector whose `client_id` nobody has approved, the authorization is refused
with a page naming the client and telling them to ask an administrator, and the client appears at
the top of **Admin → OAuth → Clients** as *Waiting for approval* with an **Approve** action. This
is what makes one trusted host — `claude.ai` publishes Claude web, Claude Desktop, Claude Code and
Cowork under separate client IDs — a decision per client rather than per vendor.

**Before upgrading:** nothing. Migration V113 approves exactly the metadata-document clients your
users are already connected through, so the upgrade disconnects nobody; clients nobody has
connected through are left to be approved when somebody asks for them. To keep the previous
behaviour, where the trusted-host list is the whole decision, set **New clients** to *Connect
automatically* under **Admin → MCP gateway → Client identification** (`oauth.cimd.approvalMode:
"auto"`).
