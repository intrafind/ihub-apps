## UI Configuration

The UI configuration defines the appearance and behavior of the iHub Apps user interface. These settings are managed through the `config/ui.json` file.

### Basic Structure

The UI configuration contains the following top-level sections:

```json
{
  "title": {
    "en": "iHub Apps",
    "de": "KI-Hub Apps"
  },
  "header": {
    /* Header configuration */
  },
  "footer": {
    "enabled": true
    /* Footer configuration */
  },
  "disclaimer": {
    "enabled": true
    /* Disclaimer text */
  },
  "icons": {
    /* Icon overrides */
  },
  "appsList": {
    /* Apps list configuration */
  },
  "startPage": {
    /* Start page configuration */
  },
  "pages": {
    /* Static page content */
  }
}
```

### Title Configuration

The `title` property defines the localized application title shown in the browser tab and various UI elements:

```json
"title": {
  "en": "iHub Apps",
  "de": "KI-Hub Apps"
}
```

### Header Configuration

The `header` section controls the appearance and content of the application header:

```json
"header": {
  "defaultColor": "rgb(0, 53, 87)",
  "favicon": "/favicon.ico",
  "logo": {
    "url": "/logo-custom-2.png",
    "alt": {
      "en": "iHub Apps Logo",
      "de": "KI-Hub Apps Logo"
    },
    "containerStyle": {
      "backgroundColor": "#fff",
      "borderBottomRightRadius": "8px",
      "justifyContent": "center",
      "padding": "0 8px"
    },
    "imageStyle": {
      "maxHeight": "80%"
    }
  },
  "links": [
    {
      "name": {
        "en": "Home",
        "de": "Startseite"
      },
      "url": "/"
    },
    // More navigation links...
  ],
  "languageSelector": {
    "enabled": true
  }
}
```

| Property                   | Type    | Description                                  |
| -------------------------- | ------- | -------------------------------------------- |
| `titleLight`               | Object  | Localized text for the light-weight part of the header title (e.g., `"iHub"`) |
| `titleBold`                | Object  | Localized text for the bold part of the header title (e.g., `" Apps"`) |
| `tagline`                  | Object  | Localized tagline displayed beneath the title (e.g., `"by IntraFind"`) |
| `defaultColor`             | String  | Background color of the classic top header (embedded contexts and `?sidebar=false`, see below) |
| `favicon`                  | String  | Path to the browser tab icon (favicon). Leave empty to use the built-in default. Configurable from the admin **UI Customization > Header** tab |
| `logo.url`                 | String  | Path to the logo image                       |
| `logo.alt`                 | Object  | Localized alt text for the logo              |
| `logo.containerStyle`      | Object  | Optional inline style for the logo container |
| `logo.imageStyle`          | Object  | Optional inline style for the logo image     |
| `links`                    | Array   | Navigation links, shown in the sidebar (and in the classic header where that is used) |
| `languageSelector.enabled` | Boolean | Show the language selector (default: true)   |

The `titleLight` and `titleBold` fields split the application name into two typographic weights. `titleLight` renders in a lighter font weight while `titleBold` renders in a heavier weight, together forming the full brand name shown in the header. Example:

```json
"header": {
  "titleLight": { "en": "iHub", "de": "iHub" },
  "titleBold": { "en": " Apps", "de": " Apps" },
  "tagline": { "en": "by IntraFind", "de": "von IntraFind" }
}
```

### Navigation Sidebar

On regular pages the top header is replaced by a collapsible left sidebar (284 px wide, or a
72 px icon rail when collapsed; the collapsed state is remembered per browser). It shows:

- the brand mark built from `header.logo`, `header.titleLight` / `header.titleBold` and
  `header.tagline`,
- a **New chat** button that leads to the [start page](#start-page-configuration) and a search
  over the user's apps,
- the configured `header.links` — entries pointing to `/` and `/apps` are represented by the
  dedicated **Home** and **Browse all apps** buttons and are not repeated; `/pages/*` links honour
  the page's `authRequired` / `allowedGroups`, and links to feature-gated routes disappear with
  the feature,
- the user's apps with favorites first (the star marks an app as favorite; favorites are stored
  per browser and shared with the start page and the apps browser),
- the account menu, the language selector (`header.languageSelector.enabled`) and the dark-mode
  toggle.

On small screens the sidebar becomes a drawer opened from a slim top bar.

The classic top header (with `header.defaultColor`) is still used where the sidebar is not: in
Microsoft Teams, Office add-ins and Nextcloud, in iframes opened with `?header=false`, and when
the sidebar is switched off. These URL parameters are remembered in the browser (`localStorage`)
until they are passed again with another value:

| Parameter        | Effect                                                                 |
| ---------------- | ---------------------------------------------------------------------- |
| `?sidebar=false` | Use the classic top header instead of the sidebar (`?sidebar=true` resets) |
| `?header=false`  | Hide the header and the sidebar entirely — for embedding (`?header=true` resets) |
| `?footer=false`  | Hide the footer (`?footer=true` resets)                                |

### Footer Configuration

The `footer` section controls the appearance and content of the application footer:

```json
"footer": {
  "enabled": true,
  "text": {
    "en": "© 2025 iHub Apps. All rights reserved.",
    "de": "© 2025 KI-Hub Apps. Alle Rechte vorbehalten."
  },
  "links": [
    {
      "name": {
        "en": "Privacy Policy",
        "de": "Datenschutzerklärung"
      },
      "url": "/page/privacy"
    },
    // More footer links...
  ]
}
```

| Property  | Type    | Description                                   |
| --------- | ------- | --------------------------------------------- |
| `enabled` | Boolean | Whether to display the footer (default: true) |
| `text`    | Object  | Localized copyright text for the footer       |
| `links`   | Array   | Navigation links for the footer               |

Setting `enabled` to `false` will completely remove the footer from all pages.

### Disclaimer Configuration

The `disclaimer` section defines the legal disclaimer shown to users:

```json
"disclaimer": {
  "enabled": true,
  "text": {
    "en": "Disclaimer text in English...",
    "de": "Disclaimer text in German..."
  },
  "version": "1.0",
  "updated": "2023-01-01",
  "hint": {
    "en": "Short hint text displayed below chat input...",
    "de": "Kurzer Hinweistext unter der Chat-Eingabe..."
  },
  "link": "/pages/disclaimer"
}
```

| Property  | Type    | Description                                                                      |
| --------- | ------- | -------------------------------------------------------------------------------- |
| `enabled` | Boolean | Whether to display the disclaimer (default: true)                                |
| `text`    | Object  | Localized disclaimer text shown in the disclaimer modal                          |
| `version` | String  | Version of the disclaimer                                                        |
| `updated` | String  | Date the disclaimer was last updated                                             |
| `hint`    | Object  | (Optional) Localized hint text shown below the chat input with info icon        |
| `link`    | String  | (Optional) URL or page path to open when the hint is clicked (e.g., /pages/disclaimer, https://example.com/disclaimer) |

Setting `enabled` to `false` will completely remove the disclaimer from the application.

**Note:** If `link` is not provided, the hint will be displayed as non-clickable text. If `hint` is not provided, a default hint text will be shown.

### Error & Empty-State Messages

The `errorPages` section lets administrators customize the localized text shown on the
application's error and empty-state screens. This covers the generic error boundary, the HTTP
error pages (404 / 500 / 403 / 401), and the "no apps available" state on the apps list.

Every field is a localized object (`{ "en": "…", "de": "…", … }`) and is **optional**. When a
field is left empty or omitted, the screen falls back to the built-in translation — so behavior is
unchanged until you fill something in.

```json
"errorPages": {
  "generic": {
    "title": { "en": "Something went wrong", "de": "Etwas ist schiefgelaufen" },
    "description": {
      "en": "An unexpected error occurred in the application. The development team has been notified.",
      "de": "Ein unerwarteter Fehler ist in der Anwendung aufgetreten. Das Entwicklungsteam wurde benachrichtigt."
    }
  },
  "notFound": {
    "title": { "en": "Page Not Found", "de": "Seite nicht gefunden" },
    "message": { "en": "We couldn't find the page you're looking for.", "de": "Die gesuchte Seite konnte nicht gefunden werden." }
  },
  "serverError": {
    "title": { "en": "Server Error", "de": "Serverfehler" },
    "message": { "en": "Something went wrong on our end.", "de": "Auf unserer Seite ist etwas schiefgelaufen." },
    "subtitle": { "en": "Please try again later.", "de": "Bitte versuchen Sie es später erneut." }
  },
  "forbidden": {
    "title": { "en": "Forbidden", "de": "Zugriff verweigert" },
    "message": { "en": "Access to this resource is forbidden.", "de": "Der Zugriff auf diese Ressource ist nicht erlaubt." }
  },
  "unauthorized": {
    "title": { "en": "Unauthorized", "de": "Nicht autorisiert" },
    "message": { "en": "You don't have permission to access this page.", "de": "Sie haben keine Berechtigung, auf diese Seite zuzugreifen." }
  },
  "noApps": {
    "title": { "en": "No apps available from server", "de": "Keine Apps vom Server verfügbar" },
    "message": { "en": "Check if the server is running and returning data correctly.", "de": "Prüfen Sie, ob der Server läuft und Daten korrekt zurückgibt." }
  }
}
```

| Screen         | Fields                       | Where it appears                                                    |
| -------------- | ---------------------------- | ------------------------------------------------------------------ |
| `generic`      | `title`, `description`       | Application error boundary — shown when an unexpected error occurs  |
| `notFound`     | `title`, `message`           | 404 page                                                           |
| `serverError`  | `title`, `message`, `subtitle` | 500 page                                                         |
| `forbidden`    | `title`, `message`           | 403 page                                                           |
| `unauthorized` | `title`, `message`           | 401 page                                                           |
| `noApps`       | `title`, `message`           | Apps list, when the server returns no applications                 |

**Editing in the admin panel:** Go to **Admin → UI Customization → Error Pages**. Each screen has
its own group of fields, and every field uses the multi-language editor (add/remove languages,
auto-translate). Click **Save Changes** to apply — no restart is needed.

**Action buttons** (e.g. "Return Home", "Retry", "Go Back") are not part of `errorPages`; they
remain controlled by the application's bundled translations.

> **Note on the generic error boundary:** because it renders above the UI-config provider (the
> provider itself may be what failed), the generic screen reads its text from a snapshot cached in
> the browser after the last successful config load. The first time a user visits after a config
> change, the generic screen may briefly use the bundled defaults until the new config is cached.

### Icons Configuration

The `icons` section allows overriding which icon is used for certain UI elements. Icon names can
be any built-in name from the `Icon` component or a custom SVG placed under `public/icons` (or the
directory specified by `VITE_ICON_BASE_URL`). See [Icons](icons.md) for the complete list of
built-in icons and instructions for adding custom SVGs.

```json
"icons": {
  "assistantMessage": "apps-svg-logo",
  "userMessage": "user",
  "appsListLogo": "/uploads/assets/my-custom-logo.svg"
}
```

| Property           | Type   | Description                                                        |
| ------------------ | ------ | ------------------------------------------------------------------ |
| `assistantMessage` | String | Icon identifier for messages from the assistant                    |
| `userMessage`      | String | Icon identifier for user messages                                  |
| `appsListLogo`     | String | Icon identifier for the logo displayed on the apps list/home page  |

Icon values accept two formats:

- **Short name** (e.g., `"apps-svg-logo"`) — resolves to `/icons/{name}.svg` via the `Icon` component. Custom SVGs can be placed under `public/icons/`.
- **Direct path or URL** (e.g., `"/uploads/assets/my-logo.svg"`) — used as-is. Upload icons via the Assets tab in the admin panel and paste the URL directly.

The `appsListLogo` can also be configured from the admin panel under **UI Customization > Content > Page Content**.

### Apps List Configuration

The `appsList` section controls the behavior and appearance of the apps browser at `/apps` — the full list with search, categories and sorting. The home page `/` is the [start page](#start-page-configuration), which links to the apps browser.

```json
"appsList": {
  "title": {
    "en": "AI Apps",
    "de": "KI-Anwendungen"
  },
  "subtitle": {
    "en": "Choose an application to start a conversation",
    "de": "Wählen Sie eine Anwendung, um ein Gespräch zu beginnen"
  },
  "search": {
    "enabled": true,
    "placeholder": {
      "en": "Search apps...",
      "de": "Apps suchen..."
    },
    "width": "w-full sm:w-2/3 lg:w-1/3"
  },
  "sort": {
    "enabled": true,
    "default": "relevance"
  }
}
```

| Property             | Type    | Description                                                                 |
| -------------------- | ------- | --------------------------------------------------------------------------- |
| `title`              | Object  | Localized title for the apps list page (overrides the translation value)    |
| `subtitle`           | Object  | Localized subtitle for the apps list page (overrides the translation value) |
| `search.enabled`     | Boolean | Enable or disable the search functionality (default: true)                  |
| `search.placeholder` | Object  | Localized placeholder text for the search input                             |
| `search.width`       | String  | CSS width classes for the search container (using Tailwind format)          |
| `sort.enabled`       | Boolean | Enable or disable client-side sorting (default: true)                       |
| `sort.default`       | String  | Default sorting mode: `relevance`, `nameAsc`, or `nameDesc`                 |

Setting `search.enabled` to `false` will completely remove the search functionality from the apps list page.

### App Categories

The `appsList.categories` section enables a category filter bar on the apps list page. Users can click a category to filter the visible apps. The `category` field in each app's JSON configuration must match one of the `id` values defined here.

```json
"appsList": {
  "categories": {
    "enabled": true,
    "showAll": true,
    "list": [
      {
        "id": "all",
        "name": { "en": "All", "de": "Alle" },
        "color": "#6B7280"
      },
      {
        "id": "coding",
        "name": { "en": "Coding", "de": "Programmierung" },
        "color": "#10B981"
      },
      {
        "id": "writing",
        "name": { "en": "Creative Writing", "de": "Kreatives Schreiben" },
        "color": "#F59E0B"
      },
      {
        "id": "business",
        "name": { "en": "Business", "de": "Geschäft" },
        "color": "#3B82F6"
      },
      {
        "id": "analysis",
        "name": { "en": "Analysis", "de": "Analyse" },
        "color": "#8B5CF6"
      },
      {
        "id": "communication",
        "name": { "en": "Communication", "de": "Kommunikation" },
        "color": "#EF4444"
      },
      {
        "id": "utility",
        "name": { "en": "Utility", "de": "Hilfsmittel" },
        "color": "#06B6D4"
      }
    ]
  }
}
```

| Property           | Type    | Description |
| ------------------ | ------- | ----------- |
| `enabled`          | Boolean | Show or hide the category filter bar (default: `true`). |
| `showAll`          | Boolean | Prepend an "All" button that shows every app regardless of category (default: `true`). |
| `list`             | Array   | Ordered list of category objects. |
| `list[].id`        | String  | Unique category identifier. Must match the `category` field in app configs. |
| `list[].name`      | Object  | Localized display name for the category button. |
| `list[].color`     | String  | Hex color used for the category badge and button accent. |

The same `categories` structure is also available under `promptsList.categories` and follows identical rules for the prompts library.

### Start Page Configuration

The start page at `/start` is a personalized landing view: a time-based greeting, the chat input
of a default app so users can start a conversation immediately, a grid of app shortcuts and a
link to the full apps browser at `/apps`. It is where
`/` sends users by default, and where the sidebar's **New chat** button always goes. Messages
typed on the start page open the app at `/apps/{appId}` and are sent right away; attachments
added on the start page are carried into the chat. The input follows the default app's model settings: the
model selector appears unless the app disables it, lists the models the current user may use
with that app, and shows the same "No models available" notice as the chat when the user's
groups permit none.

The input is the default app's real chat input, so its **+** menu offers the same per-chat
features the app itself offers — web search, the app's tools, the transcription toggle, the
image-generation settings and Magic Prompt — each shown only when the app (and the platform
feature flag) enables it. The toggles open in the state already chosen for that app in the
current session, and whatever is picked applies to the first message when it is sent in the app.

The `startPage` section configures it. It can be edited under **Admin → UI Customization →
Start Page**; existing installations receive the defaults through a configuration migration.

```json
"startPage": {
  "defaultPage": "start",
  "showDefaultApp": true,
  "showUserName": true,
  "defaultAppId": "chat",
  "title": {
    "en": "{{greeting}}, {{name}}!",
    "de": "{{greeting}}, {{name}}!"
  },
  "subtitle": {
    "en": "How can I help you today?",
    "de": "Wie kann ich Ihnen heute helfen?"
  },
  "appsMode": "order",
  "appsCount": 4,
  "sidebarAppsCount": 5,
  "featuredAppIds": ["chat", "translator"]
}
```

| Property           | Type    | Description                                                                                                                                                            |
| ------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defaultPage`      | String  | Which view `/` opens: `start` (default), `apps`, `page` or `app`. See [Choosing the home page](#choosing-the-home-page).                                                |
| `defaultPageId`    | String  | ID of the content page shown when `defaultPage` is `page`. Must be a key of the `pages` section.                                                                        |
| `defaultPageAppId` | String  | ID of the app opened when `defaultPage` is `app`.                                                                                                                       |
| `showDefaultApp`   | Boolean | Show the default app's chat input on the start page (default: `true`). When `false`, the page shows the greeting and the featured apps only.                            |
| `defaultAppId`     | String  | ID of the app whose chat input is shown. When unset — or when the current user cannot access that app — the first app the user can access is used instead.              |
| `showUserName`     | Boolean | Greet the user by name (default: `true`). When `false`, the heading is the time-based greeting alone. See [The heading](#the-heading).                                  |
| `title`            | Object  | Localized heading that replaces the built-in greeting. Supports the `{{greeting}}` and `{{name}}` placeholders. See [The heading](#the-heading).                        |
| `subtitle`         | Object  | Localized line shown under the greeting (overrides the translation value).                                                                                             |
| `appsMode`         | String  | How apps that are neither favorites nor default apps rank in both app-shortcut lists: `order` (default) or `recent`. See [App shortcuts](#app-shortcuts).               |
| `appsCount`        | Number  | How many apps the start-page grid shows (0–12, default `4`). `0` hides the grid.                                                                                        |
| `sidebarAppsCount` | Number  | How many apps the sidebar's Apps section shows (0–12, default `5`). `0` hides the list.                                                                                 |
| `featuredAppIds`   | Array   | Ids of the default apps, shown in this order right after each user's favorites. Empty by default.                                                                       |

#### App shortcuts

The start-page grid and the sidebar's **Apps** section are the same list of shortcuts in two
places, so they share one ranking and one set of settings. The ranking is always:

1. **The user's favorites** — the apps they starred, which no configuration can push off the list.
2. **The default apps** — `featuredAppIds`, in exactly the order the array holds them.
3. **Everything else** — by `appsMode`: `order` uses each app's `order` field (see
   [Apps](apps.md)), `recent` puts each user's most recently used apps first, the same way the
   apps browser's *Relevance* sorting does.

Ties fall back to the app's localized name, so the lists never reshuffle between renders. Apps a
user may not access are filtered out before ranking, so a default app that is disabled or outside
the user's groups is simply skipped.

`appsCount` and `sidebarAppsCount` then cut the ranked list to length; because they are separate,
the start page can show a wide grid while the sidebar stays short. Setting either to `0` hides
that list. The collapsed sidebar rail shows the same ranking, trimmed to the icons that fit.

Two related settings live elsewhere:

- **The order of the apps themselves** is edited in **Admin → Apps → Reorder** — drag a row or use
  the up/down arrows, then **Save order**. That writes each app's `order` field, so it also
  changes the apps browser. All apps are always listed there, so search and filters do not apply
  while reordering.
- **The default chat app** (`defaultAppId`, the chat input on the start page) is separate from the
  default apps above. When it is unset, the top-ranked chat app is used — favorites first, then
  the default apps, then `order`. `appsMode` deliberately does not apply here: with `recent`, the
  chat input would change app every time the user opened a different one.

#### The heading

By default the heading is the greeting for the time of day plus the user's name — "Good morning,
Ada!". The name comes from the identity provider: `user.name`, or the local part of the email
address when there is no name. Anonymous visitors are always greeted without one.

Not every directory delivers a presentable name — some hand over an id, a login or an empty
field. Two settings cover that:

- **`showUserName: false`** drops the name, leaving "Good morning!". Nothing else changes, and
  the greeting stays translated for every UI language.
- **`title`** replaces the heading with your own text, per language. Two placeholders are
  available: `{{greeting}}` for the greeting of the time of day ("Good morning") and `{{name}}`
  for the user's name. Anything else in the field is shown verbatim, so a fixed message such as
  `"Welcome to the AI Hub"` works as well.

When there is no name to show — an anonymous visitor, a missing name, or `showUserName: false` —
a `{{name}}` placeholder is dropped together with the separator in front of it, so
`"{{greeting}}, {{name}}!"` reads "Good morning!" rather than "Good morning, !". A `title` that
renders empty (a blank field, or only a `{{name}}` the user does not have) falls back to the
built-in greeting, so the page is never left without a heading.

Leave `title` unset to use the bundled greeting translations, which cover every UI language; a
configured `title` only covers the languages you write into it (other languages fall back to
`en`, as everywhere else).

#### Choosing the home page

`/` is a pointer, not a page of its own: it redirects to one of the views below — after signing
in, and whenever a user clicks the logo. `defaultPage` picks which. Every view keeps its own
route either way, so the URL bar, the sidebar's active item, the document title and bookmarks
always agree with what is on screen.

| Value   | `/` opens                           | Route         |
| ------- | ----------------------------------- | ------------- |
| `start` | The personalized start page         | `/start`      |
| `apps`  | The apps browser                    | `/apps`       |
| `page`  | The content page in `defaultPageId` | `/pages/{id}` |
| `app`   | The app in `defaultPageAppId`       | `/apps/{id}`  |

```json
"startPage": {
  "defaultPage": "page",
  "defaultPageId": "welcome"
}
```

Notes:

- **The start page stays reachable.** `/start` renders it whatever `defaultPage` is set to, and
  the sidebar's *New chat* button always links there.
- **Access still applies.** A content page with `authRequired` or `allowedGroups`, or an app a
  user's groups do not permit, shows the usual access-denied screen. Pick a target everyone who
  reaches `/` can open.
- **A missing target is not a dead end.** When `defaultPage` is `page` or `app` but the matching
  id is unset, `/` falls back to `/start`.

### Prompts List Configuration

The `promptsList` section controls sorting behavior of the prompts library:

```json
"promptsList": {
  "sort": {
    "enabled": true,
    "default": "relevance"
  }
}
```

| Property       | Type    | Description                                                 |
| -------------- | ------- | ----------------------------------------------------------- |
| `sort.enabled` | Boolean | Enable or disable client-side sorting (default: true)       |
| `sort.default` | String  | Default sorting mode: `relevance`, `nameAsc`, or `nameDesc` |

### Static Pages

The `pages` section contains content for static pages that can be accessed through the application:

```json
"pages": {
  "privacy": {
    "title": {
      "en": "Privacy Policy",
      "de": "Datenschutzerklärung"
    },
    "content": {
      "en": "# Privacy Policy\n\n**Last Updated: April 9, 2025**\n\n...",
      "de": "# Datenschutzerklärung\n\n**Zuletzt aktualisiert: 9. April 2025**\n\n..."
    }
  },
  // More static pages...
}
```

Each page has:

- A localized `title`
- Localized `content` in Markdown format
- `authRequired` (optional): Require authentication to view the page
- `allowedGroups` (optional): Array of group IDs allowed to view the page. Use `'*'` to allow all groups (default if omitted). Groups are defined in `contents/config/groups.json`.

### URL Routing

Static pages can be accessed through URL routes using the pattern `/page/{pageId}`, where `{pageId}` corresponds to the key in the `pages` object (e.g., `/page/privacy` for the privacy policy).

Navigation links pointing to pages are automatically hidden if the current user does not meet the `authRequired` or `allowedGroups` restrictions.
These settings can also be managed via the admin interface at `/admin/pages`.

The main user-facing routes are:

| Route           | Page                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------- |
| `/`             | [Start page](#start-page-configuration)                                                     |
| `/apps`         | Apps browser ([`appsList`](#apps-list-configuration))                                       |
| `/apps/{appId}` | Chat with an app                                                                            |
| `/prompts`      | Prompts library (`promptsList`, feature flag `promptsLibrary`)                              |
| `/pages/{id}`   | Static pages                                                                                |
| `/chats`        | Chat history — preview behind the `chatHistoryPreview` feature flag (off by default, sample data only) |

### Theme Configuration

The `theme` section controls the color palette used throughout the UI. All color values are CSS color strings (hex, rgb, etc.).

```json
"theme": {
  "primaryColor": "#4f46e5",
  "primaryDark": "#4338ca",
  "accentColor": "#10b981",
  "backgroundColor": "#f5f7f8",
  "surfaceColor": "#ffffff",
  "textColor": "#1a1a2e",
  "textMutedColor": "#6b7280",
  "darkMode": {
    "primaryColor": "#4f46e5",
    "backgroundColor": "#1a1a2e",
    "surfaceColor": "#16213e",
    "textColor": "#f5f5f5",
    "textMutedColor": "#a0a0a0"
  }
}
```

| Property | Type | Description |
| -------- | ---- | ----------- |
| `primaryColor` | String | Main brand color used for buttons, active states, and links. |
| `primaryDark` | String | Darker variant of the primary color used for hover states. |
| `accentColor` | String | Secondary accent color used for highlights and badges. |
| `backgroundColor` | String | Page background color in light mode. |
| `surfaceColor` | String | Card and panel background color in light mode. |
| `textColor` | String | Primary text color in light mode. |
| `textMutedColor` | String | Secondary / muted text color in light mode. |
| `darkMode` | Object | Color overrides applied when the user has dark mode active. Supports `primaryColor`, `backgroundColor`, `surfaceColor`, `textColor`, and `textMutedColor`. |

Theme colors are injected as CSS custom properties at runtime, so they affect the entire application without a page reload when changed through the admin panel.

### PWA Configuration

The `pwa` section controls Progressive Web App metadata. When `enabled` is `true`, the application can be installed as a standalone desktop or mobile app through the browser's "Add to Home Screen" / "Install" prompt.

```json
"pwa": {
  "enabled": false,
  "name": "iHub Apps",
  "shortName": "iHub",
  "description": "AI-powered applications platform",
  "themeColor": "#003557",
  "backgroundColor": "#ffffff",
  "display": "standalone",
  "icons": {
    "icon192": "/icons/icon-192.png",
    "icon512": "/icons/icon-512.png",
    "iconApple": "/icons/icon-192.png"
  }
}
```

| Property | Type | Description |
| -------- | ---- | ----------- |
| `enabled` | Boolean | Enable PWA support and the web app manifest. Defaults to `false`. |
| `name` | String | Full application name shown during installation. |
| `shortName` | String | Short name shown on the home screen icon label (max ~12 characters recommended). |
| `description` | String | Brief description of the application. |
| `themeColor` | String | Browser chrome color shown on mobile (address bar, status bar). |
| `backgroundColor` | String | Splash screen background color shown before the app loads. |
| `display` | String | Display mode: `standalone` (no browser UI), `fullscreen`, `minimal-ui`, or `browser`. |
| `icons.icon192` | String | Path to the 192×192 PNG icon. |
| `icons.icon512` | String | Path to the 512×512 PNG icon. |
| `icons.iconApple` | String | Path to the Apple Touch icon (180×180 recommended). |

To enable PWA support:

1. Set `pwa.enabled` to `true`.
2. Place your icon files in the `public/icons/` directory.
3. Update the icon paths to match your files.
4. Save the configuration. The web app manifest is served automatically at `/manifest.json`.
