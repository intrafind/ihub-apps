# 2026-02-26 Theming and Branding System

## Overview

This document describes the implementation of a comprehensive theming and branding system for iHub Apps, allowing admins to configure brand colors, dark mode, and visual appearance via the admin panel without file system access.

## Problem Statement

Previously, custom branding required file system access (via `custom.css` with `!important` overrides) and manual patching of `index.html` after each update. This approach is:
- Brittle and hard to maintain
- Impossible for admins without file system access
- Lost on updates

## Solution

A proper theming system that:
1. Allows admins to configure brand colors, logo, and app name via admin UI
2. Applies themes via CSS custom properties (no `!important` hacks)
3. Provides first-class dark mode toggle with user preference persistence
4. Supports custom CSS upload as an escape hatch
5. Hot-reloads theme changes without server restart

## Implementation

### Components

#### Client Side

1. **useDarkMode Hook** (`client/src/hooks/useDarkMode.js`)
   - Manages dark mode state with localStorage persistence (`ih-dark-mode` key)
   - Supports three modes: `auto` (system), `light`, `dark`
   - Listens for system preference changes via `matchMedia`
   - Sets `data-theme="dark"` attribute on `<html>` for Tailwind compatibility

2. **DarkModeToggle Component** (`client/src/shared/components/DarkModeToggle.jsx`)
   - Button in header with sun/moon icons
   - Cycles through modes: auto → light → dark → auto
   - Screen reader accessible with proper ARIA labels

3. **Enhanced StyleEditor** (`client/src/features/admin/components/StyleEditor.jsx`)
   - New "Theme & Appearance" tab with color pickers
   - Light mode and dark mode color configuration
   - Live preview panel showing both modes
   - Color validation with error feedback

4. **UIConfigContext Updates** (`client/src/shared/contexts/UIConfigContext.jsx`)
   - Injects theme CSS link (`/api/theme.css`) into document head
   - Cache-busting timestamp for real-time theme updates

#### Server Side

1. **Theme CSS Endpoint** (`server/routes/themeRoutes.js`)
   - `GET /api/theme.css` generates dynamic CSS
   - CSS custom properties for light and dark modes
   - Sanitizes CSS variable names and values for security
   - ETag support for caching, `no-cache` for immediate updates
   - Includes custom CSS from admin configuration

2. **Configuration Migration** (`server/migrations/V012__add_theme_config.js`)
   - Adds `theme` section to existing `ui.json` configurations
   - Sets default values for light and dark mode colors

### Generated CSS Variables

```css
:root {
  --ih-primary: #4f46e5;
  --ih-primary-dark: #4338ca;
  --ih-accent: #10b981;
  --ih-bg: #f5f7f8;
  --ih-surface: #ffffff;
  --ih-text: #1a1a2e;
  --ih-text-muted: #6b7280;
}

[data-theme="dark"] {
  --ih-primary: #4f46e5;
  --ih-primary-dark: #4338ca;
  --ih-accent: #10b981;
  --ih-bg: #1a1a2e;
  --ih-surface: #16213e;
  --ih-text: #f5f5f5;
  --ih-text-muted: #a0a0a0;
}
```

### Configuration Schema

```json
{
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
}
```

## Security Considerations

1. **CSS Injection Prevention**
   - `sanitizeCSSName()` only allows alphanumeric, hyphens, underscores
   - `sanitizeCSSValue()` removes structural characters (`;{}\\<>`)
   - Empty sanitized names are rejected

2. **Color Validation**
   - Client-side hex color validation with error feedback
   - Server-side validation of 3-character and 6-character hex formats

3. **Dark Mode Persistence**
   - Stored in localStorage (no cookies, no server storage)
   - No PII involved

## Files Changed

### New Files
- `client/src/hooks/useDarkMode.js`
- `client/src/shared/components/DarkModeToggle.jsx`
- `server/routes/themeRoutes.js`
- `server/migrations/V012__add_theme_config.js`

### Modified Files
- `client/src/shared/components/Icon.jsx` - Added Sun, Moon, ComputerDesktop icons
- `client/src/shared/components/Layout.jsx` - Added DarkModeToggle to header
- `client/src/shared/contexts/UIConfigContext.jsx` - Theme CSS injection
- `client/src/features/admin/components/StyleEditor.jsx` - Enhanced theme UI
- `server/server.js` - Registered theme routes
- `server/defaults/config/ui.json` - Added theme configuration
- `shared/i18n/en.json` - English translations
- `shared/i18n/de.json` - German translations

## Testing

1. **Dark Mode Toggle**
   - Click toggle cycles through auto → light → dark → auto
   - Preference persists across page reloads
   - System preference changes reflected when in auto mode

2. **Theme CSS Endpoint**
   - `curl http://localhost:3000/api/theme.css` returns valid CSS
   - ETag changes when theme configuration changes
   - 304 Not Modified returned when ETag matches

3. **Admin Theme Configuration**
   - Color pickers update theme values
   - Invalid hex colors show validation error
   - Preview panel reflects changes in real-time

## Future Enhancements

- Logo upload with drag-and-drop support
- Additional CSS variable support for component-level theming
- Theme presets (e.g., "Corporate Blue", "Dark Modern")
- Custom font configuration
