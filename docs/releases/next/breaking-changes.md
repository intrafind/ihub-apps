# Breaking Changes — Unreleased

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

## A custom `CONTENTS_DIR` is honoured everywhere

On installations that set `CONTENTS_DIR`, the default `admin` account could not sign in after a
fresh setup, users and OAuth clients created in the admin UI were invisible to sign-in and token
checks, and uploaded skills never loaded. Several other things were written to a `contents/`
folder next to the configured one. All of it now uses the configured contents directory.
Installations that keep the default name `contents` see no change.

- Sign-in, OAuth client checks and skill loading follow `CONTENTS_DIR`. Migration V121 removes
  `localAuth.usersFile`, `oauth.clientsFile` and `skills.skillsDirectory` from `platform.json`
  where they still hold the shipped `contents/…` value. A path you set yourself is kept.
- UI asset uploads, the browser-extension signing key, the audit log, change history, agent
  artifacts, inboxes and memory, page sources, custom renderers and OpenAPI tool files now live
  in the configured directory.
- Configuration backups always store files under `contents/` in the archive, so a backup made on
  one installation imports into another whatever each calls its contents directory.

**Before upgrading:** nothing if you do not set `CONTENTS_DIR`. If you do, look for a `contents/`
folder in the installation root next to your configured directory. Move anything under its
`uploads/`, `data/`, `agents/memory/`, `skills/`, `pages/` and `renderers/`, its
`config/users.json` and `config/oauth-clients.json`, and a `.browser-extension-key.pem` file, into
the matching place in your configured directory. Without that, audit history, uploaded logos and
agent memory from before the upgrade no longer appear.
