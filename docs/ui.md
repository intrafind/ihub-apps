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
| `defaultColor`             | String  | Background color for the header              |
| `logo.url`                 | String  | Path to the logo image                       |
| `logo.alt`                 | Object  | Localized alt text for the logo              |
| `logo.containerStyle`      | Object  | Optional inline style for the logo container |
| `logo.imageStyle`          | Object  | Optional inline style for the logo image     |
| `links`                    | Array   | Navigation links for the header              |
| `languageSelector.enabled` | Boolean | Show the language selector (default: true)   |

The `titleLight` and `titleBold` fields split the application name into two typographic weights. `titleLight` renders in a lighter font weight while `titleBold` renders in a heavier weight, together forming the full brand name shown in the header. Example:

```json
"header": {
  "titleLight": { "en": "iHub", "de": "iHub" },
  "titleBold": { "en": " Apps", "de": " Apps" },
  "tagline": { "en": "by IntraFind", "de": "von IntraFind" }
}
```

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

### Icons Configuration

The `icons` section allows overriding which icon is used for certain UI elements. Icon names can be any built-in name from the `Icon` component or a custom SVG placed under `public/icons` (or the directory specified by `VITE_ICON_BASE_URL`).

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

The `appsList` section controls the behavior and appearance of the apps list/home page:

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
