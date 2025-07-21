# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Essential Commands

```bash
# Install all dependencies (root, client, server)
npm run install:all
npx playwright install

# Start development environment (server + client with hot reload)
npm run dev

# Build for production
npm run prod:build

# Run production build
npm run start:prod

# Build as standalone binary
./build.sh --binary
```

### Code Quality

```bash
# Lint all files and auto-fix issues (run before committing)
npm run lint:fix

# Format all files with Prettier
npm run format:fix

# Verify server starts correctly after changes
timeout 10s node server/server.js || echo "Server startup check completed"
```

### Testing

```bash
# Test LLM adapters
npm run test:openai
npm run test:anthropic
npm run test:google
npm run test:mistral
npm run test:all

# Test authentication security
cd server && node tests/authentication-security.test.js

# Test tool calling functionality
npm run test:tool-calling
```

## Architecture Overview

### High-Level Structure

AI Hub Apps is a full-stack application for creating and managing AI-powered applications. It consists of three main components:

- **Server** (`/server`): Node.js Express backend with LLM adapters and authentication
- **Client** (`/client`): React/Vite frontend with Tailwind CSS
- **Contents** (`/contents`): JSON configuration files for apps, models, and UI

### Server Architecture

#### Core Components

- **`server.js`**: Main Express server with clustering support
- **`configCache.js`**: Memory-based configuration caching service
- **`serverHelpers.js`**: Shared middleware and utility functions
- **`routes/`**: Modular route handlers organized by feature

#### LLM Integration

- **`adapters/`**: Provider-specific implementations (OpenAI, Anthropic, Google, Mistral)
- **`services/chat/`**: Chat service abstraction with streaming support
- **Request flow**: Client → Express → Adapter → LLM Provider → Streaming Response

#### Authentication System

Uses a flexible multi-mode authentication system:

- **Anonymous**: No authentication required
- **Local**: Built-in username/password with JWT
- **OIDC**: OpenID Connect integration for enterprise SSO
- **Proxy**: Header-based auth + JWT validation

Key files:

- **`middleware/authRequired.js`**: Authentication enforcement middleware
- **`utils/authorization.js`**: Group-based permission system with `isAnonymousAccessAllowed()`, `enhanceUserWithPermissions()`, `resolveGroupInheritance()`
- **`routes/auth.js`**: Authentication endpoints and user management

##### Group Inheritance System

The authentication system supports hierarchical group inheritance, allowing complex permission structures:

- **Inheritance Chain**: Groups can inherit permissions from parent groups using the `inherits` array
- **Automatic Resolution**: Inheritance is resolved at configuration load time for performance
- **Circular Dependency Detection**: System prevents and throws errors for circular inheritance chains
- **Permission Merging**: Child groups merge permissions from all parent groups, with their own permissions taking precedence
- **Built-in Hierarchy**: Standard hierarchy follows `admin` → `users` → `authenticated` → `anonymous`

Example inheritance chain:

```
admin (inherits from users) → users (inherits from authenticated) → authenticated (inherits from anonymous) → anonymous (base)
```

#### Configuration Architecture

- **`configCache.js`**: Centralized configuration loading and caching
- **`contents/config/`**: JSON configuration files (apps, models, platform, groups, etc.)
- **Real-time loading**: No server restart needed for most config changes

### Client Architecture

#### Feature-Based Organization

```
client/src/
├── features/          # Feature modules (apps, auth, chat, admin)
├── shared/           # Shared components and contexts
├── pages/            # Page components (UnifiedPage for dynamic content)
├── api/              # API client with caching
└── utils/            # Client utilities
```

#### React Component Rendering System

AI Hub Apps supports dynamic React component rendering through the `ReactComponentRenderer` and `UnifiedPage` components:

**Key Components:**
- **`UnifiedPage.jsx`**: Main page component that handles both markdown and React content
- **`ReactComponentRenderer.jsx`**: Compiles and renders JSX code dynamically in the browser
- **Auto-detection**: Automatically identifies React/JSX content vs markdown content

**Architecture Flow:**
1. **Content Loading**: `fetchPageContent()` retrieves page content from `/contents/pages/{lang}/{id}.jsx`
2. **Type Detection**: System detects content type based on JSX patterns (`function`, `useState`, `<Components>`, etc.)
3. **Dynamic Compilation**: For React content, Babel Standalone compiles JSX to JavaScript in the browser
4. **Safe Execution**: Components execute in controlled environment with provided React hooks and props
5. **Error Handling**: Comprehensive error boundaries with clear development feedback

**Component Structure Requirements:**
- Components must be named `UserComponent`
- Receive props containing React hooks: `{ React, useState, useEffect, useRef, etc. }`
- No export statements needed (handled automatically)
- Full access to Tailwind CSS classes

**Available Props for Components:**
- React hooks: `React`, `useState`, `useEffect`, `useMemo`, `useCallback`, `useRef`
- App context: `t` (translation), `navigate` (router), `user` (user data)

**Security & Performance:**
- Components run in isolated execution context using `new Function()`
- Babel loaded once from multiple CDN sources with fallbacks
- Export statements automatically stripped before execution
- Error boundaries prevent app crashes

#### Key Features

- **React Router**: SPA routing with protected routes
- **Context API**: Global state for auth, platform config, UI config
- **Tailwind CSS**: Utility-first styling with dark/light mode
- **Real-time Chat**: EventSource for LLM streaming responses

#### State Management

- **AuthContext**: User authentication and permissions
- **PlatformConfigContext**: Server configuration and feature flags
- **UIConfigContext**: UI customization and localization

### Configuration System

#### Core Configuration Files

- **`platform.json`**: Server behavior, authentication, authorization
- **`apps.json`**: AI application definitions with prompts and variables
- **`models.json`**: LLM model configurations and endpoints
- **`groups.json`**: User groups, permissions, and inheritance hierarchy
- **`ui.json`**: UI customization, pages, and branding

#### Groups Configuration Structure

The `groups.json` file defines user groups with hierarchical inheritance support:

```javascript
{
  "groups": {
    "admin": {
      "id": "admin",
      "name": "Admin",
      "description": "Full administrative access to all resources",
      "inherits": ["users"],                    // Inherits from users group
      "permissions": {
        "apps": ["*"],
        "prompts": ["*"],
        "models": ["*"],
        "adminAccess": true
      },
      "mappings": ["Admins", "IT-Admin"]        // External group mappings
    },
    "users": {
      "id": "users",
      "name": "Users",
      "description": "Standard user group with extended permissions",
      "inherits": ["authenticated"],            // Inherits from authenticated group
      "permissions": {
        "apps": [],                            // Merged with inherited permissions
        "prompts": ["analysis"],
        "models": ["gemini-2.0-flash"],
        "adminAccess": false
      }
    }
  }
}
```

**Key Features:**

- **`inherits`**: Array of parent group IDs to inherit permissions from
- **Permission Merging**: Child permissions are merged with inherited permissions
- **External Mappings**: `mappings` array links external auth provider groups to internal groups
- **Performance**: Groups cached with resolved inheritance for fast runtime access

#### App Configuration Structure

Apps are defined with:

- **Metadata**: Name, description, icon, color
- **AI Settings**: System prompt, token limits, preferred model
- **Variables**: User input fields with types (string, date, select, etc.)
- **Permissions**: Group-based access control

#### App Configuration Schema

Apps must conform to the Zod schema defined in `server/validators/appConfigSchema.js`:

```javascript
{
  id: string,                           // Required: Unique app identifier
  order: number,                        // Optional: Display order
  name: object,                         // Required: Localized app names
  description: object,                  // Required: Localized descriptions
  color: string,                        // Required: UI color theme
  icon: string,                         // Required: Icon identifier
  system: object,                       // Required: Localized system prompts
  tokenLimit: number,                   // Required: Maximum tokens per request
  preferredModel: string,               // Optional: Default model selection
  preferredOutputFormat: string,        // Optional: Output format preference
  preferredStyle: string,               // Optional: Style preference
  preferredTemperature: number,         // Optional: Temperature setting
  sendChatHistory: boolean,             // Optional: Include chat history
  messagePlaceholder: object,           // Optional: Localized input placeholder
  prompt: object,                       // Optional: Localized user prompts
  variables: array,                     // Optional: Input variable definitions
  settings: any,                        // Optional: Additional settings
  inputMode: any,                       // Optional: Input mode configuration
  imageUpload: any,                     // Optional: Image upload settings
  fileUpload: any,                      // Optional: File upload settings
  features: any,                        // Optional: Feature flags
  greeting: any,                        // Optional: Welcome message
  starterPrompts: array,                // Optional: Suggested prompts
  sourcePath: string,                   // Optional: Source file path
  allowedModels: array,                 // Optional: Restricted model list
  disallowModelSelection: boolean,      // Optional: Hide model selector
  allowEmptyContent: boolean,           // Optional: Allow empty submissions
  tools: array,                         // Optional: Available tool names
  outputSchema: any,                    // Optional: Structured output schema
  category: string,                     // Optional: App category
  enabled: boolean,                     // Optional: Enable/disable app
  // Inheritance fields
  allowInheritance: boolean,            // Optional: Allow child apps
  parentId: string,                     // Optional: Parent app ID
  inheritanceLevel: number,             // Optional: Inheritance depth
  overriddenFields: array               // Optional: Fields overridden from parent
}
```

## Development Patterns

### Authentication Flow

1. **Configuration Loading**: `loadGroupsConfiguration()` loads and resolves group inheritance automatically
2. **Middleware**: `authRequired` or `authOptional` on routes
3. **Permission Check**: `isAnonymousAccessAllowed(platformConfig)`
4. **User Enhancement**: `enhanceUserWithPermissions()` adds resolved group permissions
5. **Resource Filtering**: `filterResourcesByPermissions()` based on merged user permissions

#### Group Inheritance Resolution

The system automatically resolves group inheritance at startup:

1. **Load Configuration**: Groups loaded from `groups.json`
2. **Dependency Resolution**: `resolveGroupInheritance()` processes inheritance chains
3. **Circular Detection**: Prevents circular dependencies with error reporting
4. **Permission Merging**: Parent permissions merged with child permissions
5. **Cache Storage**: Resolved groups cached for runtime performance

### Adding New Features

1. **Server Route**: Add to appropriate `routes/` subdirectory
2. **Client Feature**: Create feature module in `client/src/features/`
3. **Configuration**: Add to relevant JSON config file
4. **Permissions**: Update `groups.json` if needed

### LLM Provider Integration

To add a new LLM provider:

1. Create adapter in `server/adapters/` implementing standard interface
2. Add model configurations in `contents/models/`
3. Register adapter in `server/adapters/index.js`

### Configuration Changes

- **Platform/Auth**: Requires server restart
- **Apps/Models/UI**: Reloaded automatically via `configCache`
- **Groups/Permissions**: Reloaded automatically with inheritance resolution

## Important Implementation Details

### Authentication Configuration

The system uses `anonymousAuth` structure instead of legacy `allowAnonymous`:

```json
{
  "anonymousAuth": {
    "enabled": true,
    "defaultGroups": ["anonymous"]
  }
}
```

### Security Considerations

- **No hardcoded secrets**: API keys via environment variables only
- **Group-based permissions**: All resource access controlled by user groups
- **Request validation**: Input validation on all API endpoints
- **Authentication bypass prevention**: `authRequired` middleware on protected routes

### Performance Optimizations

- **Configuration caching**: `configCache` eliminates disk I/O on requests
- **Group inheritance resolution**: Computed once at startup and cached for runtime performance
- **Permission caching**: User permissions computed once and cached
- **ETag support**: Client-side caching for static resources
- **Clustering**: Multi-worker support for production scaling

### Error Handling

- **Graceful degradation**: Fallbacks for missing configuration
- **Localized errors**: Error messages support internationalization
- **Comprehensive logging**: Structured logging for debugging

## Code Quality Standards

- **ESLint 9.x**: Modern flat config with comprehensive rules
- **Prettier**: Consistent code formatting
- **Pre-commit hooks**: Automatic linting on staged files
- **No commented code**: Remove unused code rather than commenting
- **ES modules**: Use `import/export` syntax throughout
- **Error handling**: Always handle async operations properly

## File Structure Context

### Critical Server Files

- **`server/server.js`**: Main application entry point
- **`server/utils/authorization.js`**: Core authentication/authorization logic
- **`server/configCache.js`**: Configuration management system
- **`server/routes/chat/dataRoutes.js`**: Primary API endpoints for frontend

### Critical Client Files

- **`client/src/App.jsx`**: Main React application and routing
- **`client/src/shared/contexts/AuthContext.jsx`**: Authentication state management
- **`client/src/features/apps/pages/AppChat.jsx`**: Core chat interface
- **`client/src/pages/UnifiedPage.jsx`**: Dynamic page component for React/markdown content
- **`client/src/shared/components/ReactComponentRenderer.jsx`**: JSX compilation and rendering engine

### Configuration Files

- **`contents/config/platform.json`**: Core platform configuration
- **`contents/config/apps.json`**: AI application definitions
- **`contents/config/groups.json`**: User permissions and groups

### Dynamic Content Files

- **`contents/pages/{language}/{page-id}.md`**: Markdown content files
- **`contents/pages/{language}/{page-id}.jsx`**: React component files
- **Examples**: `contents/pages/en/qr-generator.jsx`, `contents/pages/en/dashboard.md`

#### React Component File Structure

React components in the pages directory must follow this structure:

```jsx
function UserComponent(props) {
  const { React, useState, useEffect, useRef, t, navigate, user } = props;
  
  // Component logic here
  
  return (
    <div className="p-4">
      {/* JSX content */}
    </div>
  );
}
// No export statement needed - handled automatically
```

**Key Requirements:**
- Function must be named `UserComponent`
- Destructure needed props from the `props` parameter
- Use Tailwind CSS for styling
- No import/export statements needed
- Access to all React hooks and app context through props

This architecture supports enterprise-grade AI applications with flexible authentication, real-time chat, and extensive customization capabilities.
