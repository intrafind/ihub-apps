# Features — 5.5.0

## New Start Page and Navigation Sidebar

The home page (`/`) is now a personalized start page, and on regular pages the top header is
replaced by a collapsible left sidebar.

- The start page greets the user by name, shows the chat input of a default app so a conversation
  can start right away (the message and any attachments are carried into the app), lists up to
  four featured apps (favorites first) and links to the full apps browser.
- The apps browser moved to `/apps` and uses a compact row layout with a star to mark favorites.
  Search, categories and sorting work as before, and the existing `appsList` settings (title,
  subtitle, search, sort) continue to apply there.
- The sidebar (284 px, collapsible to a 72 px icon rail — the state is remembered per browser)
  shows the brand from the header configuration, a **New chat** button, app search, the configured
  header links, the user's apps with favorites first, the account menu, the language selector and
  the dark-mode toggle. On small screens it opens as a drawer from a slim top bar.
- Admins configure the start page under **UI Customization → Start Page** (`ui.json → startPage`):
  show or hide the chat input, pick the default app, and set the subtitle. Existing installations
  receive the defaults through a configuration migration, so nothing changes until an admin edits
  them.
- Embedded contexts keep the classic header: Microsoft Teams, Office add-ins, Nextcloud and
  `?header=false` iframes are not affected. `?sidebar=false` switches a regular browser session
  back to the top header.
- Preview: a **Chat History** feature flag (off by default) adds recent chats to the sidebar and a
  `/chats` page. It shows sample data only until chat persistence is implemented — leave it off in
  production.
