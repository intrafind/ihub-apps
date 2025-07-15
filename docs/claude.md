# Claude Integration

This document provides details about using Anthropic's Claude models within AI Hub Apps.

## Overview

Claude models are accessed via the Anthropic Messages API. Configuration files under `contents/models` define the available models. Each model entry specifies the API endpoint, token limits, and display names.

## Configuration

To add or adjust a Claude model, edit the corresponding JSON file in `contents/models/`. Provide:

- `id`: unique identifier
- `modelId`: the Anthropic model name
- `name`: object with `en` and `de` translations
- `description`: object with `en` and `de` translations

## Internationalization

All strings related to Claude models or apps must include English (`en`) and German (`de`) translations. Update the following files when adding new keys:

- Built-in translations: `shared/i18n/{lang}.json`
- Overrides: `contents/locales/{lang}.json`
- Never assume English is the default language. Use the `defaultLanguage` value
  from the backend platform configuration.

## Development and Testing

### Server Startup Testing

After making any changes to the server code, especially imports, dependencies, or architecture, always test that the server starts correctly:

```bash
# Test server startup with timeout to catch errors quickly
timeout 10s node server/server.js || echo "Server startup check completed"

# Test full development environment
timeout 15s npm run dev || echo "Development environment startup check completed"
```

**Important**: This testing should be done after every build or significant refactoring to ensure:

- No import errors
- No missing dependencies
- Server starts without runtime errors
- All modules load correctly

If the server fails to start, check the error output for:

- Missing or incorrect import paths
- Module export/import mismatches
- Syntax errors
- Missing dependencies
