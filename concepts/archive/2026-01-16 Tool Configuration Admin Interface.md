# Tool Configuration Admin Interface

**Date**: 2026-01-16  
**Status**: Implemented  
**Feature Type**: Admin Interface Enhancement

## Overview

This document describes the implementation of a comprehensive admin interface for managing AI tools / function calling in the iHub Apps platform. The feature allows non-technical administrators to create, edit, configure, enable/disable, and manage both tool configurations and their underlying JavaScript code.

## Problem Statement

The system supports tool/function calling where LLMs can access external systems, perform calculations, call web services, etc. Tools are individual JavaScript scripts with configurations stored in `tools.json`. Currently, these configurations can only be modified by editing JSON files directly, which is not suitable for non-technical administrators.

### Requirements

1. View all tools with their configurations
2. Create new tools including code
3. Modify existing tool configurations
4. Edit tool JavaScript code
5. Enable/disable tools
6. Download and upload tool configurations
7. Delete tools
8. Support for different tool types:
   - Regular tools (single function with script)
   - Multi-function tools (multiple functions in one script, e.g., Entra People Search)
   - Special tools (provider-specific, no script, e.g., Google Search Grounding)

## Architecture

### Backend Components

#### Routes (`server/routes/admin/tools.js`)

New admin API endpoints:

- **GET `/api/admin/tools`** - List all tools (including disabled)
- **GET `/api/admin/tools/:toolId`** - Get specific tool configuration
- **POST `/api/admin/tools`** - Create new tool
- **PUT `/api/admin/tools/:toolId`** - Update tool configuration
- **DELETE `/api/admin/tools/:toolId`** - Delete tool
- **POST `/api/admin/tools/:toolId/toggle`** - Toggle enabled/disabled state
- **GET `/api/admin/tools/:toolId/script`** - Get tool script content
- **PUT `/api/admin/tools/:toolId/script`** - Update tool script content

All endpoints require admin authentication via `adminAuth` middleware.

#### Configuration Management

Tools are stored in `CONTENTS_DIR/config/tools.json` (defaults to `contents/config/tools.json`). The configuration cache (`configCache.js`) automatically handles:

- Loading tools from JSON
- Expanding multi-function tools into individual tool entries
- Caching with ETag support
- Refresh on updates

#### File Structure

```
server/
├── routes/
│   ├── adminRoutes.js        # Registers tools routes
│   └── admin/
│       └── tools.js          # Tools admin routes
├── tools/                     # Tool script files
│   ├── braveSearch.js
│   ├── entraPeopleSearch.js
│   └── ...
└── defaults/config/
    └── tools.json            # Default tools configuration
```

### Frontend Components

#### Pages

1. **AdminToolsPage.jsx** - List view
   - Displays all tools in a table
   - Search by name, description, or ID
   - Filter by enabled/disabled status
   - Filter by tool type (regular/multi-function/special)
   - Actions: Edit, Clone, Download, Delete, Enable/Disable
   - Upload configuration files
   - Create new tool button

2. **AdminToolEditPage.jsx** - Edit/Create view
   - Two tabs: Configuration and Script Editor
   - Configuration tab:
     - Tool ID (immutable after creation)
     - Multilingual name (EN/DE)
     - Multilingual description (EN/DE)
     - Script filename
     - Concurrency limit
     - Enabled toggle
     - Parameters (JSON Schema editor)
   - Script Editor tab (only for existing tools with scripts):
     - Code editor for JavaScript
     - Save button to update script file

#### Navigation Integration

- Added to `AdminHome` dashboard as "Tools Management"
- Added to `AdminNavigation` menu under "Content Management"
- Routes configured in `App.jsx`:
  - `/admin/tools` - List page
  - `/admin/tools/:toolId` - Edit page
  - `/admin/tools/new` - Create page

#### API Client (`client/src/api/adminApi.js`)

New API methods:
- `fetchAdminTools()` - Get all tools
- `fetchAdminTool(toolId)` - Get specific tool
- `createTool(toolData)` - Create new tool
- `updateTool(toolId, toolData)` - Update tool config
- `deleteTool(toolId)` - Delete tool
- `toggleTool(toolId)` - Toggle enabled state
- `fetchToolScript(toolId)` - Get script content
- `updateToolScript(toolId, content)` - Update script

## Data Models

### Tool Configuration Schema

```json
{
  "id": "string (required)",
  "name": {
    "en": "string (required)",
    "de": "string (optional)"
  },
  "description": {
    "en": "string (required)",
    "de": "string (optional)"
  },
  "script": "string (optional - filename in server/tools/)",
  "enabled": "boolean (default: true)",
  "concurrency": "number (optional, default: 5)",
  "parameters": {
    "type": "object",
    "properties": {},
    "required": []
  },
  "provider": "string (optional - for special tools)",
  "isSpecialTool": "boolean (optional)",
  "functions": {
    "functionName": {
      "description": {},
      "parameters": {}
    }
  }
}
```

### Tool Types

1. **Regular Tools**:
   - Single function
   - Has `script` property
   - No `functions` property
   - Example: `braveSearch.js`

2. **Multi-Function Tools**:
   - Multiple functions in one script
   - Has `script` property
   - Has `functions` object with multiple function definitions
   - System expands into individual tool entries
   - Example: `entraPeopleSearch.js` with `findUser`, `getAllUserDetails`, etc.

3. **Special Tools**:
   - Provider-specific (e.g., Google Search Grounding)
   - Has `provider` and/or `isSpecialTool` property
   - No `script` property
   - Handled specially by the system

## Security Considerations

1. **Authentication**: All admin routes require `adminAuth` middleware
2. **Path Validation**: Tool IDs validated with `validateIdForPath` to prevent directory traversal
3. **File System**: Scripts stored in dedicated `server/tools/` directory
4. **Environment Variables**: CONTENTS_DIR configurable, defaults to `contents`
5. **No Direct Execution**: Scripts are not executed during configuration changes

## Usage Flow

### Creating a New Tool

1. Navigate to `/admin/tools`
2. Click "Create New Tool"
3. Fill in required fields:
   - Unique ID
   - Name (EN/DE)
   - Description (EN/DE)
   - Script filename (if not special tool)
   - Parameters JSON Schema
4. Set concurrency and enabled state
5. Click "Save"
6. (Optional) Navigate to Script Editor tab to add code
7. Save script content

### Editing an Existing Tool

1. Navigate to `/admin/tools`
2. Click on a tool or click Edit icon
3. Modify configuration in Configuration tab
4. Switch to Script Editor tab to edit code (if applicable)
5. Save changes

### Enabling/Disabling a Tool

1. Navigate to `/admin/tools`
2. Click the eye/eye-slash icon for the tool
3. Tool state toggles immediately

### Downloading/Uploading Configurations

- **Download**: Click download icon on a tool to get JSON configuration
- **Upload**: Click "Upload Config" and select a JSON file
  - System validates required fields
  - Prevents ID conflicts
  - Updates cache automatically

## Implementation Details

### Cache Management

- Tools loaded from `config/tools.json` via configLoader
- Cached in `configCache` with ETag support
- Automatic refresh on updates via `configCache.refreshCacheEntry('config/tools.json')`
- Multi-function tools expanded automatically during cache load

### Directory Creation

Backend automatically creates `contents/config/` directory if it doesn't exist:

```javascript
await fs.mkdir(join(rootDir, contentsDir, 'config'), { recursive: true });
```

### Validation

- **Frontend**: Basic required field validation
- **Backend**: 
  - ID uniqueness check
  - Required fields validation (`id`, `name`, `description`)
  - Path security validation

## Testing

### Manual Testing Required

1. **CRUD Operations**:
   - Create new tool ✓ (server startup test passed)
   - Read tool configuration
   - Update tool configuration
   - Delete tool

2. **Script Editing**:
   - Load script content
   - Edit and save script
   - Verify file changes

3. **Enable/Disable**:
   - Toggle tool state
   - Verify in tools list
   - Verify cache refresh

4. **UI Testing**:
   - Navigation flows
   - Search and filters
   - Upload/download
   - Error handling
   - Responsive design

### Automated Testing

- Server startup test: ✓ Passed
- Routes registered correctly in Swagger: ✓ Confirmed
- Linting: ✓ No errors

## Future Enhancements

1. **Code Editor Enhancement**:
   - Integrate Monaco Editor for better code editing experience
   - Syntax highlighting
   - IntelliSense/autocomplete
   - Error detection

2. **Validation**:
   - JSON Schema validation for parameters
   - Script syntax validation before save
   - Test execution capability

3. **Version Control**:
   - Track configuration changes
   - Rollback capability
   - Change history

4. **Import/Export**:
   - Bulk export all tools
   - Bulk import from archive
   - Migration tools

5. **Documentation**:
   - In-app help/documentation
   - Parameter schema examples
   - Script templates

## Related Files

### Backend
- `server/routes/admin/tools.js` - Admin routes
- `server/routes/adminRoutes.js` - Route registration
- `server/configCache.js` - Configuration caching
- `server/toolLoader.js` - Tool loading logic
- `server/tools/*.js` - Tool script files

### Frontend
- `client/src/features/admin/pages/AdminToolsPage.jsx` - List view
- `client/src/features/admin/pages/AdminToolEditPage.jsx` - Edit view
- `client/src/features/admin/pages/AdminHome.jsx` - Dashboard
- `client/src/features/admin/components/AdminNavigation.jsx` - Navigation
- `client/src/api/adminApi.js` - API client
- `client/src/App.jsx` - Route configuration

### Configuration
- `server/defaults/config/tools.json` - Default tools
- `contents/config/tools.json` - Active configuration (created on first run)

## Notes

- The implementation follows existing admin patterns (prompts, models, apps)
- Multilingual support for EN/DE (extensible to other languages)
- ETag caching for performance
- Compatible with existing tool system
- No breaking changes to existing functionality
