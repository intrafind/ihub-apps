# Locale Override Examples

This directory contains examples of how to override localization strings in iHub Apps.

## How It Works

The locale override system allows you to customize specific translation strings without modifying the base translation files. This is perfect for:

- Customizing branding (e.g., app names, titles)
- Adapting terminology for your organization
- Providing company-specific translations
- Overriding specific UI labels

## Directory Structure

```
contents/
└── locales/
    ├── en.json     # English overrides
    ├── de.json     # German overrides
    └── ...         # Other language overrides
```

## Basic Example

Create a file at `contents/locales/en.json` with only the keys you want to override:

```json
{
  "app": {
    "title": "My Company AI Apps"
  },
  "common": {
    "save": "Speichern",
    "welcome": "Welcome to My Company!"
  }
}
```

## Complete Override Examples

### English Override (`contents/locales/en.json`)

```json
{
  "app": {
    "title": "Acme Corporation AI Suite",
    "subtitle": "Powered by Advanced AI"
  },
  "common": {
    "save": "Save Changes",
    "cancel": "Discard",
    "loading": "Please wait..."
  },
  "auth": {
    "login": {
      "title": "Acme Employee Portal"
    }
  }
}
```

### German Override (`contents/locales/de.json`)

```json
{
  "app": {
    "title": "Acme KI-Suite",
    "subtitle": "Angetrieben von fortschrittlicher KI"
  },
  "common": {
    "save": "Änderungen speichern",
    "cancel": "Verwerfen",
    "loading": "Bitte warten..."
  },
  "auth": {
    "login": {
      "title": "Acme Mitarbeiterportal"
    }
  }
}
```

## Important Notes

1. **Minimal Files**: Only include keys you want to override. The system will merge your overrides with the base translations.

2. **Nested Keys**: You can override nested keys at any level:
   ```json
   {
     "deeply": {
       "nested": {
         "key": "Custom value"
       }
     }
   }
   ```

3. **Unknown Keys**: If you include a key that doesn't exist in the base translations, it will be ignored with a warning in the logs.

4. **Hot Reload**: Changes to locale override files are automatically reloaded without requiring a server restart.

5. **Validation**: The system validates that override keys exist in the base translations to prevent typos.

## Finding Available Keys

To see all available translation keys that you can override, check the base translation files:

- English: `shared/i18n/en.json`
- German: `shared/i18n/de.json`

## Testing Your Overrides

After creating your override files:

1. Start or restart the server
2. Check the logs for messages like:
   ```
   Locale cached { language: 'en', keyCount: 1234, overrideCount: 5 }
   ```
3. The `overrideCount` shows how many keys were overridden
4. Check for any warnings about unknown keys

## Common Use Cases

### Branding Override
```json
{
  "app": {
    "title": "Your Company Name",
    "subtitle": "Your Tagline Here"
  }
}
```

### Button Labels
```json
{
  "common": {
    "save": "Submit",
    "cancel": "Go Back",
    "delete": "Remove",
    "edit": "Modify"
  }
}
```

### Authentication Labels
```json
{
  "auth": {
    "login": {
      "title": "Employee Login",
      "username": "Employee ID",
      "password": "Access Code"
    }
  }
}
```

### Custom Terminology
```json
{
  "chat": {
    "newChat": "New Conversation",
    "chatHistory": "Previous Discussions",
    "model": "AI Engine"
  }
}
```

## Troubleshooting

### Override Not Applied
- Check that the file is in `contents/locales/` directory
- Verify the file is valid JSON (use a JSON validator)
- Check server logs for any errors
- Ensure the key exists in the base translation files

### Warnings in Logs
If you see warnings like `Unknown locale key in overrides`, it means you're trying to override a key that doesn't exist in the base translations. Check the spelling and path of your key.

### Server Not Reloading Changes
Locale overrides support hot-reload, but you can manually trigger a reload by:
1. Touching the override file (modify and save)
2. Or restart the server

## Advanced: Environment-Specific Overrides

You can maintain different override files for different environments:

```bash
# Development
cp contents/locales/en.dev.json contents/locales/en.json

# Production
cp contents/locales/en.prod.json contents/locales/en.json
```

Or use symbolic links:
```bash
ln -s en.prod.json contents/locales/en.json
```
