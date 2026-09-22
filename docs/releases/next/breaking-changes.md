# Breaking Changes — Unreleased

## Email context and uploads reach the model as tagged blocks

Every client — web app, Teams, Nextcloud, the Outlook task pane and the browser extension — now
sends the same message shape. When a message carries anything besides the typed text, the server
wraps each piece in a named block — `<current_email>`, `<pinned_emails>`, `<current_meeting>`,
`<current_page>`, `<documents>` — adds a fixed `<context_rules>` note and puts the typed text in
`<user_instruction>`. All of it goes where the app's prompt template has `{{content}}`. A message
that is only typed text is sent as typed.

- Uploaded files are no longer placed above the app's prompt as `[File: name (type)]` sections.
  They are `<document>` entries inside `{{content}}`, so a template that says "the document
  below" now finds the document where it says.
- Email attachments are `<document>` entries too, marked `source="email_attachment"`.
- The `--- Current email ---`, `--- Pinned emails ---` and `--- Current meeting ---` headings are
  gone.

**Before upgrading:** nothing for the shipped apps — migrations V108 and V121 update the meeting
apps, the Translator, the Summarizer and Outlook – Reply Directly unless you edited their prompts.
Check custom app prompts that quote `{{content}}` (`"{{content}}"`), refer to `[File: …]` or to the
old headings: name the blocks instead, as described under "What `{{content}}` contains" in the App
Configuration guide.

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

## The iFinder JWT subject uses the configured field, or fails

**JWT Subject Field** under **Admin → Integrations → iFinder** decides which user attribute becomes
the `sub` claim iFinder identifies people by. It used to be a preference rather than an
instruction: with `email` selected, a user without an email was sent under their username, then
their internal id; `domain\username` sent a bare account name whenever no domain was known; and a
template placeholder with no value left a gap in the middle of the subject.

Each of those produced a valid, signed token for the *wrong* principal. iFinder keys its user
mapping on `sub`, so the mapping was created against whatever arrived — and nothing on either side
reported a problem. A misconfiguration surfaced much later as one user seeing another's documents,
or as permissions that made no sense.

The configured field is now the only one consulted. When the authenticated user has no value for
it, token generation fails with an error naming the setting and the missing attribute, and the
request fails rather than reaching iFinder under a different identity.

**Before upgrading:** run **Test connection** on the iFinder admin page. It mints a real token and
reports the subject, so a setting that was only working through a fallback shows up there instead
of at runtime. Two cases to look for:

- **Subject Field is `email`, but some users have no email in the directory.** They were being sent
  under their username or id; they will now be refused. Switch the field to `username`, or populate
  the email attribute.
- **Subject Field is `domain\username` with LDAP.** No LDAP user ever had a domain, so every such
  token has been going out as a bare account name. Set **Domain** on the LDAP provider (or leave it
  empty against Active Directory, which now detects it) — and check which form iFinder's user
  mapping actually holds, since until now it can only have been the unqualified one.
