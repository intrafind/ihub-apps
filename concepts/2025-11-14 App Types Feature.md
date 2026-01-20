# App Types Feature

**Date**: 2025-11-14
**Status**: Implementation in Progress

## Overview

This document describes the implementation of different app types in iHub Apps. Currently, all apps are chat-based by default. This feature adds support for:
- **Chat apps** (default, existing behavior)
- **Redirect apps** (direct external URL navigation)
- **Iframe apps** (embedded external applications)

## Business Requirements

Customers need the ability to use app tiles for purposes beyond chat interfaces:
1. Dictation apps with specialized interfaces
2. External application integration via redirect
3. Embedded applications via iframe
4. Future extensibility for additional app types

## Technical Design

### 1. Configuration Schema

Add an optional `type` field to the app configuration schema (`server/validators/appConfigSchema.js`):

```javascript
type: z.enum(['chat', 'redirect', 'iframe']).optional().default('chat')
```

For redirect and iframe types, add type-specific configuration:

```javascript
// For redirect apps
redirectConfig: z.object({
  url: z.string().url(),
  openInNewTab: z.boolean().optional().default(true)
}).optional()

// For iframe apps
iframeConfig: z.object({
  url: z.string().url(),
  allowFullscreen: z.boolean().optional().default(true),
  sandbox: z.array(z.string()).optional()
}).optional()
```

### 2. Backend Changes

**Files to modify:**
- `server/validators/appConfigSchema.js` - Add type and config fields
- `server/appsLoader.js` - No changes needed (handles all fields automatically)
- `server/routes/apps.js` - Ensure type is included in API responses

**Validation rules:**
- `type` defaults to 'chat' for backward compatibility
- Validate that `redirectConfig` is present when `type` is 'redirect'
- Validate that `iframeConfig` is present when `type` is 'iframe'
- Chat-specific fields can be optional for non-chat types

### 3. Frontend Changes

**Routing (`client/src/App.jsx`):**
```jsx
// Current route
<Route path="apps/:appId" element={<SafeAppChat />} />

// New routing logic needed
<Route path="apps/:appId" element={<AppRouterWrapper />} />
```

**New Components:**

1. **`AppRouterWrapper.jsx`** - Determines which component to render based on app type
2. **`RedirectApp.jsx`** - Handles redirect type apps
3. **`IframeApp.jsx`** - Handles iframe type apps
4. **`AppChat.jsx`** - Existing chat component (no changes needed)

**AppsList.jsx modifications:**
- Add visual indicators (badges/icons) for non-chat app types
- Update click behavior for redirect apps (can redirect immediately if configured)
- Ensure proper accessibility labels

### 4. Data Flow

```
User clicks app tile
  ↓
AppsList → /apps/:appId route
  ↓
AppRouterWrapper fetches app details
  ↓
Based on app.type:
  - 'chat' → AppChat component (existing)
  - 'redirect' → RedirectApp component (immediate redirect or confirmation page)
  - 'iframe' → IframeApp component (renders iframe with configured URL)
```

### 5. Example Configurations

**Redirect App Example:**
```json
{
  "id": "external-tool",
  "name": {
    "en": "External Tool",
    "de": "Externes Tool"
  },
  "description": {
    "en": "Opens external application",
    "de": "Öffnet externe Anwendung"
  },
  "type": "redirect",
  "redirectConfig": {
    "url": "https://external-tool.example.com",
    "openInNewTab": true
  },
  "color": "#10B981",
  "icon": "external-link",
  "enabled": true
}
```

**Iframe App Example:**
```json
{
  "id": "embedded-app",
  "name": {
    "en": "Embedded Application",
    "de": "Eingebettete Anwendung"
  },
  "description": {
    "en": "Application running in iframe",
    "de": "In iFrame ausgeführte Anwendung"
  },
  "type": "iframe",
  "iframeConfig": {
    "url": "https://app.example.com",
    "allowFullscreen": true,
    "sandbox": ["allow-scripts", "allow-same-origin"]
  },
  "color": "#8B5CF6",
  "icon": "window",
  "enabled": true
}
```

### 6. Backward Compatibility

- All existing apps without a `type` field default to 'chat'
- No migration needed for existing configurations
- Chat-specific fields (system, tokenLimit, etc.) remain optional but unused for non-chat types
- Existing routing continues to work

### 7. Security Considerations

**Iframe Security:**
- Use `sandbox` attribute with appropriate permissions
- Validate URLs to prevent XSS
- Consider Content Security Policy headers
- Document security implications for admins

**Redirect Security:**
- Validate redirect URLs on backend
- Warn users when redirecting to external sites
- Consider whitelist of allowed domains

### 8. UI/UX Considerations

**Visual Indicators:**
- Badge on app tile showing type (e.g., "External", "Embedded")
- Different icon treatment for non-chat apps
- Clear indication before redirect

**User Experience:**
- For redirects: Show confirmation page with "Continue to external site" button
- For iframes: Show loading state while iframe loads
- For all types: Maintain consistent navigation and header

### 9. Admin Interface

Update admin app creation/editing forms to:
- Add app type selector
- Show/hide relevant configuration fields based on type
- Validate type-specific configurations
- Provide helpful hints and examples

### 10. Internationalization

New translation keys needed:
```json
{
  "appTypes": {
    "chat": "Chat Application",
    "redirect": "External Link",
    "iframe": "Embedded Application"
  },
  "appTypeDescriptions": {
    "chat": "Interactive chat interface",
    "redirect": "Opens external website",
    "iframe": "Embedded web application"
  },
  "redirectApp": {
    "externalSite": "External Site",
    "continueButton": "Continue to {{appName}}",
    "warning": "You are about to leave iHub Apps"
  },
  "iframeApp": {
    "loading": "Loading application...",
    "error": "Failed to load embedded application"
  }
}
```

## Implementation Order

1. **Backend schema updates** - Add type and config fields with validation
2. **Backend API changes** - Ensure type is included in responses
3. **Frontend routing** - Create AppRouterWrapper component
4. **Frontend components** - Implement RedirectApp and IframeApp
5. **Visual indicators** - Update AppsList with type badges
6. **Admin interface** - Add type selector and config fields
7. **Examples and documentation** - Provide sample configurations
8. **Testing** - Validate all app types work correctly

## Testing Strategy

1. **Backward compatibility**: Verify existing chat apps work unchanged
2. **Redirect apps**: Test immediate and confirmed redirects, new tab vs same tab
3. **Iframe apps**: Test embedding, sandbox permissions, fullscreen
4. **Admin interface**: Test creating/editing apps of each type
5. **Visual indicators**: Verify badges and icons display correctly
6. **Security**: Test URL validation, XSS prevention
7. **Internationalization**: Verify all new strings have translations

## Future Enhancements

- **Canvas type**: Specialized UI for drawing/diagramming apps
- **Form type**: Pre-built form interfaces
- **Dashboard type**: Analytics and reporting interfaces
- **Configurable permissions**: Role-based access per app type
- **App type plugins**: Extensible system for custom app types

## Related Files

- `server/validators/appConfigSchema.js` - Schema validation
- `server/appsLoader.js` - App loading logic
- `client/src/App.jsx` - Main routing
- `client/src/features/apps/pages/AppChat.jsx` - Chat component
- `client/src/features/apps/pages/AppsList.jsx` - App listing
- `client/src/features/admin/pages/AdminAppEditPage.jsx` - Admin interface
- `examples/apps/` - Example configurations
