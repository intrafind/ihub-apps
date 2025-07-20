## UI Configuration

The UI configuration defines the appearance and behavior of the AI Hub Apps user interface. These settings are managed through the `config/ui.json` file.

### Basic Structure

The UI configuration contains the following top-level sections:

```json
{
  "title": {
    "en": "AI Hub Apps",
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
  "en": "AI Hub Apps",
  "de": "KI-Hub Apps"
}
```

### Header Configuration

The `header` section controls the appearance and content of the application header:

```json
"header": {
  "defaultColor": "rgb(0, 53, 87)",
  "logo": {
    "url": "/logo-bmas-2.png",
    "alt": {
      "en": "AI Hub Apps Logo",
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
| `defaultColor`             | String  | Background color for the header              |
| `logo.url`                 | String  | Path to the logo image                       |
| `logo.alt`                 | Object  | Localized alt text for the logo              |
| `logo.containerStyle`      | Object  | Optional inline style for the logo container |
| `logo.imageStyle`          | Object  | Optional inline style for the logo image     |
| `links`                    | Array   | Navigation links for the header              |
| `languageSelector.enabled` | Boolean | Show the language selector (default: true)   |

### Footer Configuration

The `footer` section controls the appearance and content of the application footer:

```json
"footer": {
  "enabled": true,
  "text": {
    "en": "© 2025 AI Hub Apps. All rights reserved.",
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
  "updated": "2023-01-01"
}
```

| Property  | Type    | Description                                       |
| --------- | ------- | ------------------------------------------------- |
| `enabled` | Boolean | Whether to display the disclaimer (default: true) |
| `text`    | Object  | Localized disclaimer text                         |
| `version` | String  | Version of the disclaimer                         |
| `updated` | String  | Date the disclaimer was last updated              |

Setting `enabled` to `false` will completely remove the disclaimer from the application.

### Icons Configuration

The `icons` section allows overriding which icon is used for certain UI elements. Icon names can be any built-in name from the `Icon` component or a custom SVG placed under `public/icons` (or the directory specified by `VITE_ICON_BASE_URL`).

```json
"icons": {
  "assistantMessage": "apps-svg-logo",
  "userMessage": "user"
}
```

| Property           | Type   | Description                                     |
| ------------------ | ------ | ----------------------------------------------- |
| `assistantMessage` | String | Icon identifier for messages from the assistant |
| `userMessage`      | String | Icon identifier for user messages               |

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
