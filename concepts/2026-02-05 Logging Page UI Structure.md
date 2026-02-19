# Admin Logging Page - UI Structure

## Page Layout Overview

```
┌─────────────────────────────────────────────────────────────┐
│ Admin Navigation Bar                                         │
│ [Home] [Apps] [Models] ... [Configuration ▼] [System]       │
│                              └─ Logging ◄── NEW             │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ 📊 Logging Configuration                                    │
│ Configure logging levels, components, metadata, and debug   │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ 📈 Log Level                                                │
│ Current Level: info                                         │
│                                                             │
│ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐              │
│ │ error  │ │  warn  │ │ ✓ info │ │  http  │              │
│ └────────┘ └────────┘ └────────┘ └────────┘              │
│ ┌────────┐ ┌────────┐ ┌────────┐                          │
│ │verbose │ │ debug  │ │ silly  │                          │
│ └────────┘ └────────┘ └────────┘                          │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ 📄 Log Format                                               │
│                                                             │
│ ┌──────────────────────┐ ┌──────────────────────┐         │
│ │ ✓ json               │ │   text               │         │
│ │ Structured JSON      │ │ Human-readable text  │         │
│ └──────────────────────┘ └──────────────────────┘         │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ 🔍 Component Filtering                                      │
│                                                             │
│ ☑ Enable component filtering                               │
│ When enabled, only logs from selected components shown     │
│                                                             │
│ ☑ Server          ☑ ChatService    ☑ AuthService          │
│ ☐ ConfigCache     ☐ ApiKeyVerifier ☐ ToolExecutor         │
│ ☐ Version         ☐ DataRoutes     ☐ AdminRoutes          │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ 📁 File Logging                                             │
│                                                             │
│ ☑ Enable file logging                                      │
│                                                             │
│ Log File Path: [logs/app.log                             ] │
│ Max Size (bytes): [10485760  ]  Max Files: [5           ] │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ 🛡️ Authentication Debug Logging                             │
│                                                             │
│ ☑ Enable authentication debug logging                      │
│   │                                                         │
│   ├─ ☑ Mask tokens in logs                                │
│   ├─ ☑ Redact passwords in logs                           │
│   ├─ ☐ Enable console logging                             │
│   ├─ ☐ Include raw authentication data                    │
│   │                                                         │
│   └─ Debug by Provider:                                    │
│      ☑ oidc    ☑ local    ☑ proxy                         │
│      ☑ ldap    ☑ ntlm                                      │
│                                                             │
│ [Save Authentication Debug Settings]                        │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ 💾 Save Changes                                             │
│ Save logging configuration and apply changes immediately    │
│                                                             │
│                   [Save Logging Configuration] ───────────► │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ ℹ️ Important Notes                                          │
│ • Changes take effect immediately across all processes      │
│ • Log level changes are persisted to platform.json         │
│ • Lower levels show fewer messages, higher show more       │
│ • Use "info" for production, "debug" for development       │
│ • Authentication debug logging requires restart            │
└─────────────────────────────────────────────────────────────┘
```

## Navigation Flow

```
Admin Dashboard
    │
    └── Configuration Section (Yellow Card)
            │
            └── Logging Configuration ──► /admin/logging
                    │
                    ├── Log Level (7 options)
                    ├── Log Format (JSON/Text)
                    ├── Component Filtering (9 components)
                    ├── File Logging (path, size, rotation)
                    └── Auth Debug (providers, masking options)
```

## Admin Home - New Section

```
┌───────────────────────────────────────────────────────────┐
│ Admin Dashboard                                            │
├───────────────────────────────────────────────────────────┤
│                                                            │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐         │
│  │   Apps     │  │   Models   │  │  Prompts   │         │
│  │  Management│  │ Management │  │ Management │         │
│  └────────────┘  └────────────┘  └────────────┘         │
│                                                            │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐         │
│  │    UI      │  │  Logging   │  │   System   │         │
│  │Customization│  │   Config   │  │   Admin    │         │
│  └────────────┘  └────────────┘  └────────────┘         │
│                    ▲ NEW                                  │
└───────────────────────────────────────────────────────────┘
```

## Configuration File Impact

### Before Implementation

**AdminSystemPage:**
```javascript
// Had LoggingConfig component embedded
<LoggingConfig />  // Only log level configuration
```

**AdminAuthPage:**
```javascript
// Had authDebug in config state
authDebug: {
  enabled: false,
  maskTokens: true,
  // ... scattered throughout auth config
}
```

### After Implementation

**AdminLoggingPage (NEW):**
```javascript
// Centralized logging configuration
{
  level: 'info',
  format: 'json',
  components: { enabled: false, filter: [] },
  file: { enabled: false, path: 'logs/app.log' },
  authDebug: { ... }  // Consolidated here
}
```

**AdminSystemPage:**
```javascript
// LoggingConfig removed - cleaner focus on system settings
<SSLConfig />
<BackupConfig />
<VersionInfo />
```

## API Flow

```
User Action (UI) ──► Frontend State Update
                          │
                          ▼
                    API Call (PUT)
                          │
                          ├──► /api/admin/logging/config
                          │         │
                          │         ├── Update platform.json
                          │         ├── Reconfigure logger
                          │         └── Return success
                          │
                          └──► /api/admin/configs/config/platform
                                    │
                                    ├── Update authDebug section
                                    ├── Refresh config cache
                                    └── Return success
                          │
                          ▼
                    Success Message
                          │
                          ▼
                    Changes Applied Immediately
```

## Component Hierarchy

```
AdminLoggingPage
  ├── AdminAuth (wrapper)
  ├── AdminNavigation (sidebar)
  └── Main Content
        ├── Header Section (title, description)
        ├── Status Message (success/error banner)
        ├── Log Level Section
        │     ├── Current level display
        │     └── Level selector grid (7 buttons)
        ├── Log Format Section
        │     └── Format toggle (JSON/Text)
        ├── Component Filtering Section
        │     ├── Enable checkbox
        │     └── Component grid (9 checkboxes)
        ├── File Logging Section
        │     ├── Enable checkbox
        │     └── Configuration inputs
        ├── Auth Debug Section
        │     ├── Enable checkbox
        │     ├── Security options (4 checkboxes)
        │     ├── Provider options (5 checkboxes)
        │     └── Save button
        ├── Save Changes Section
        │     └── Save button
        └── Info Box (notes and warnings)
```

## Color Coding

- **Blue** - Primary actions, current selections
- **Green** - Success messages
- **Red** - Error messages
- **Yellow** - Section card color (Admin Home)
- **Gray** - Disabled/inactive states

## Responsive Behavior

- **Desktop (1920px+)**: 4-column grid for log levels, 3-column for components
- **Tablet (768px-1919px)**: 2-column grid for log levels, 2-column for components
- **Mobile (<768px)**: Single column for all grids

## Accessibility Features

- Semantic HTML structure
- ARIA labels for all interactive elements
- Keyboard navigation support
- High contrast dark mode
- Clear visual feedback for state changes
- Descriptive error messages
