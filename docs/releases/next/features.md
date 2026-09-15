# Features — Unreleased

## Outlook Add-in: Dark Mode

The Outlook task pane can now be switched to a dark appearance. Users open **☰ → Settings →
Appearance** inside the add-in and choose **Light**, **Dark**, or **Automatic**; the choice is
stored in the Outlook client and remembered across Outlook restarts. The browser-extension side
panel, which uses the same chat shell, gets the same setting.

- **Light** stays the default, so nothing changes for existing users until they opt in.
- **Automatic** follows the Outlook theme on clients that expose it (Mailbox requirement set 1.14
  and later — Outlook on the web, the new Outlook for Windows, current Microsoft 365 desktop
  builds) and switches live when the user changes Outlook's theme. Older Outlook versions and the
  browser extension follow the operating system's dark-mode setting instead.
- Every add-in surface is covered: sign-in, app picker, chat, the email and meeting context strip,
  pinned emails, and the app, variables and settings dialogs.
- No admin configuration is involved; the preference is per user and per device.

## Content Admins Can Choose Which Groups Use Their Content

Every app, prompt, skill, tool and workflow edit page now has a **Group access** card: groups that
already have access are listed as chips, with a search box below to find and grant the rest — the
same search-and-add pattern used to add apps, models or prompts to a group elsewhere in the admin
area, so the card stays usable when there are many groups. Picking a group in the search results
grants it, removing its chip withdraws it, and each change is saved to `groups.json` immediately —
with the same change-history snapshot and audit entry an edit in **Admin → Groups** would leave.
Until now this meant opening each group in turn and editing its list by hand.

Members of the **Content Admins** group (`contentAdmin` without full admin access) get the card as
well, scoped to the groups they are part of: a content admin in `sales` can grant or withdraw
content for `sales` and for every group that inherits from `sales`, and sees no other groups.
Being in a parent group counts — someone in `users` also manages the groups that inherit from
`users`.

- Full admins see every group; content admins only the groups they belong to plus the groups
  inheriting from those. The `authenticated` and `anonymous` groups every user carries implicitly
  do not count as membership, so a content admin cannot publish to everyone unless an
  administrator has explicitly put them in such a group.
- Only the content lists (`apps`, `prompts`, `skills`, `tools`, `workflows`) can be changed this
  way. Models, admin flags, external mappings and inheritance stay in the group editor.
- A group that holds a wildcard (`"*"`) for the type is shown as a locked chip: a single item
  cannot be withdrawn from a wildcard. Replace the wildcard with an explicit list in
  **Admin → Groups** if such a group should lose one item.
- For tools, the card grants direct MCP/A2A access, exactly like the `tools` permission itself;
  what the model may call in chat is still decided by the app.
- No admin action is required. To let a content admin manage a group's access, make them a member
  of that group, or of a group it inherits from.

## Outlook Add-in: Start Page with a Default App

The Outlook task pane now opens on a start page instead of the app list: a greeting, the chat input
of a default app with the open email right above it, the app's starter prompts, and a handful of
app shortcuts. A user can collect a few emails with **Add email(s)**, type an instruction and send —
the app opens and the message goes out immediately, with the open email and the collected emails as
context, exactly as if it had been typed inside the app. Tapping a shortcut opens that app without
a message; **All apps** leads to the full list.

- Admins configure it under **Admin → Office Integration → Start Page**
  (`platform.json → officeIntegration.startPage`): the **landing view** (start page or the app
  list), the **default chat app** (unset picks the top-ranked chat app the user can access —
  favorites first, then the default apps), and the **default apps** shown as shortcuts, in order,
  right after each user's favorites. These settings are the add-in's own; the web start page keeps
  its configuration under UI Customization.
- The start page stays usable on very small panes: it scrolls as one column, hides the subtitle
  and app descriptions on narrow panes and the starter prompts on short ones, and leaves the model
  selector, tools menu and uploads to the opened app.
- Existing installations receive `defaultPage: "start"` through configuration migration V107, so
  the pane opens on the start page after the upgrade; switching the landing view back to **All
  apps** restores the previous behaviour.

## What's New Shows Each Release on Its Own, With a Table of Contents

**Admin → What's New** now shows one release at a time instead of one ever-growing block. Pick a
release in the list on the left; it opens with a table of contents that links to every entry,
grouped into breaking changes, new & improved, and fixes — in that order, so what needs your
attention comes first.

- Every release has its own section, named after its release tag, and only when it shipped
  something worth noting. Builds from the main branch additionally show **Unreleased changes**.
- The release you are running is marked **Installed**; releases you have not opened before are
  marked **New**.
- Release notes are rendered as full Markdown. Nested lists, numbered steps, quoted error
  messages, tables and links now appear as written instead of as a run of plain lines.

No action is required; the page picks up the new layout on upgrade.
