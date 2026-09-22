# Features — 5.5.1

## Choose What the Home Page Opens

The `/` route no longer has to be the new start page. Admins pick the landing view under
**UI Customization → Start Page**, right above the default chat app setting, and everyone who
signs in or clicks the logo goes there.

- Four choices: the **start page** (greeting and chat input, unchanged default), **all apps**
  (the apps browser), a **content page** from Admin → Pages, or **a specific app** opened
  straight into its chat.
- The start page now has its own route, `/start`, alongside `/apps` for the apps browser. `/`
  simply redirects to whichever view is configured, so the URL, the sidebar's active item and
  bookmarks always match what is on screen.
- The start page stays reachable at `/start` whatever `/` is set to, and the sidebar's
  **New chat** button always goes there.
- Access rules still apply: a page or app the user's groups do not permit shows the usual
  access-denied screen, so pick a target everyone reaching `/` can open.
- Existing installations keep the start page as home; a configuration migration writes that
  choice so nothing changes until an admin picks something else.

## Configure Which Apps the Start Page and Sidebar Show, and in What Order

The start-page grid and the sidebar's Apps section used to be fixed at four and five apps ranked
by favorites and the app's `order`. Both lists are now configurable under **UI Customization →
Start Page**, and the order apps appear in can be set by drag and drop in **Admin → Apps**.

- **Default apps.** Pick the apps that lead both lists and drag them into the order you want. A
  user's own favorites always stay above them, and users who cannot access an app never see it.
- **Separate counts.** "Apps on the start page" and "Apps in the sidebar" are set independently
  (0–12 each). Set one to 0 to hide that list.
- **Ranking mode.** Everything after the favorites and the default apps follows either the
  configured order (the app's `order` field) or **Recently used first** — the same ranking the
  apps browser offers, now available on the start page and in the sidebar.
- **Reorder apps.** **Admin → Apps** has a new **Reorder** button: drag a row, or use the up/down
  arrows, then choose **Save order**. It writes each app's `order` field, so the new order also
  applies to the apps browser. Every app is listed, so search and filters do not apply while
  reordering, and nothing is saved until you confirm.
- The collapsed icon rail now shows the same ranked apps instead of favorites only, so a user with
  no favorites still gets app shortcuts there.
- Existing installations receive the current behaviour as explicit defaults through a configuration
  migration — nothing changes on screen until an admin edits the settings.

## Configurable Start Page Heading

The start page greeted every user by name. Where the directory has no presentable name — an id, a
login, an empty field — that read badly and could not be turned off. Admins now decide what the
heading says, under **UI Customization → Start Page**.

- **Greet users by name** (on by default) drops the name when switched off, leaving the
  time-based greeting alone: "Good morning!". It stays translated for every UI language.
- **Heading** replaces the greeting with your own text, per language — a fixed message such as
  "Welcome to the AI Hub", or a template built from two placeholders: `{{greeting}}` for the
  greeting of the time of day and `{{name}}` for the user's name.
- With no name to show — an anonymous visitor, a missing name, or names switched off — a
  `{{name}}` placeholder is dropped together with the separator in front of it, so
  "{{greeting}}, {{name}}!" reads "Good morning!" and never "Good morning, !". A heading that
  renders empty falls back to the built-in greeting, so the page always has one.
- Existing installations keep greeting users by name; a configuration migration writes that
  choice, and the heading stays unset so the bundled greeting translations continue to be used.
