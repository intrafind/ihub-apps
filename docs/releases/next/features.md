# Features — Unreleased

## Settings → Integrations: easier to scan with many connected apps

The Integrations page now shows its information on demand instead of all at once, so it stays
readable when a user has connected many AI clients such as several Claude Code installations.

- Each connected app is a single row with its last use, connection date and number of permissions;
  the permission list opens when the row is clicked.
- Apps connected before iHub stored display names now show the application's registered name
  instead of a technical client ID such as `client_claude_code_ihub_1eef9d16`. This applies to
  the admin connections list too.
- Connected apps are listed by most recent use. The five most recent show by default, the rest
  behind **Show all**, and a search box appears once there are more than five.
- The personal API key endpoints are folded behind an **Endpoints** toggle below the keys.
- The page is grouped into **Your accounts** (Jira, cloud storage, MCP servers) and **Access to
  iHub** (connected apps, personal API keys, Outlook add-in).
- The note that an issued access token stays valid for a while after disconnecting now appears
  in the disconnect confirmation, where it matters, and the "More integrations coming soon"
  placeholder is gone.
