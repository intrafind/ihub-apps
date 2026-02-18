# Feature Flags Utility

A clean, consistent API for checking feature flags in the iHub Apps application.

## Quick Start

### In React Components

```javascript
import useFeatureFlags from '../shared/hooks/useFeatureFlags';

function MyComponent({ app }) {
  const featureFlags = useFeatureFlags();
  
  // Check platform-level feature
  const toolsEnabled = featureFlags.isEnabled('tools', true);
  
  // Check app-level feature
  const magicEnabled = featureFlags.isAppFeatureEnabled(app, 'magicPrompt.enabled', false);
  
  // Check both levels
  const shareEnabled = featureFlags.isBothEnabled(app, 'shortLinks', true);
  
  // Get feature value
  const magicModel = featureFlags.getAppFeatureValue(app, 'magicPrompt.model', null);
  
  return <div>{/* Your component */}</div>;
}
```

### In Server Code

```javascript
import { FeatureFlags } from '../shared/featureFlags.js';

// Create an instance with platform config
const featureFlags = new FeatureFlags(platformConfig);

// Check if a feature is enabled
const toolsEnabled = featureFlags.isEnabled('tools', true);
```

## API Reference

### `isEnabled(featureId, defaultValue = true)`

Check if a platform-level feature is enabled.

**Parameters:**
- `featureId` (string): The feature identifier (e.g., 'shortLinks', 'tools', 'promptsLibrary')
- `defaultValue` (boolean): Value to return if feature flag is not explicitly set (default: `true`)

**Returns:** `boolean`

**Example:**
```javascript
const toolsEnabled = featureFlags.isEnabled('tools', true);
const promptsEnabled = featureFlags.isEnabled('promptsLibrary', true);
const workflowsEnabled = featureFlags.isEnabled('experimentalWorkflows', false);
```

---

### `isAppFeatureEnabled(app, featurePath, defaultValue = false)`

Check if an app-level feature is enabled.

**Parameters:**
- `app` (Object): The app configuration object
- `featurePath` (string): Dot-notation path to the feature (e.g., 'magicPrompt.enabled', 'shortLinks')
- `defaultValue` (boolean): Value to return if feature flag is not explicitly set (default: `false`)

**Returns:** `boolean`

**Example:**
```javascript
const magicEnabled = featureFlags.isAppFeatureEnabled(app, 'magicPrompt.enabled', false);
const canvasEnabled = featureFlags.isAppFeatureEnabled(app, 'canvas', false);
```

---

### `isBothEnabled(app, featureId, defaultValue = true)`

Check if a feature is enabled at both platform and app levels. Both must be enabled for this to return `true`.

**Parameters:**
- `app` (Object): The app configuration object
- `featureId` (string): The feature identifier (must exist at both levels)
- `defaultValue` (boolean): Value to return if feature flag is not explicitly set (default: `true`)

**Returns:** `boolean`

**Example:**
```javascript
const shareEnabled = featureFlags.isBothEnabled(app, 'shortLinks', true);
// Returns true only if BOTH platform and app have shortLinks enabled
```

---

### `getAppFeatureValue(app, featurePath, defaultValue = null)`

Get a nested app feature value (not just enabled/disabled). Useful for retrieving configuration values.

**Parameters:**
- `app` (Object): The app configuration object
- `featurePath` (string): Dot-notation path to the feature value (e.g., 'magicPrompt.model', 'magicPrompt.prompt')
- `defaultValue` (any): Value to return if the path doesn't exist (default: `null`)

**Returns:** `any` - The feature value or default

**Example:**
```javascript
const magicModel = featureFlags.getAppFeatureValue(app, 'magicPrompt.model', null);
const magicPrompt = featureFlags.getAppFeatureValue(app, 'magicPrompt.prompt', '');
const maxTokens = featureFlags.getAppFeatureValue(app, 'tokenLimit', 4096);
```

## Available Platform Features

Current platform-level features (as of 2026-02-17):

- `experimentalWorkflows` - Agentic workflow automation (default: false)
- `promptsLibrary` - Browsable library of reusable prompt templates (default: true)
- `usageTracking` - Track token usage, request counts, and costs (default: true)
- `tools` - Allow AI models to call external tools and functions (default: true)
- `sources` - Add custom knowledge sources to prompts (default: true)
- `shortLinks` - Create short URLs for apps (default: true)
- `pdfExport` - Export chat conversations as PDF (default: true)

## Common App Features

Common app-level features:

- `magicPrompt.enabled` - Enable magic prompt enhancement
- `magicPrompt.model` - Model to use for magic prompts
- `magicPrompt.prompt` - System prompt for magic prompt generation
- `shortLinks` - Allow creating short links to this app
- `canvas` - Enable canvas mode for this app

## Default Value Strategy

**Platform features (isEnabled):**
- Default to `true` - Features are enabled by default unless explicitly disabled
- Rationale: New features should be available unless turned off

**App features (isAppFeatureEnabled):**
- Default to `false` - App-specific features are opt-in
- Rationale: Apps should explicitly enable special features

**Feature values (getAppFeatureValue):**
- Default to `null` or custom value - Depends on use case
- Rationale: Allows flexible handling of missing values

## Migration Examples

### Before: Complex conditional checks
```javascript
const AppChat = ({ app }) => {
  const { platformConfig } = usePlatformConfig();
  
  // Check multiple levels with complex logic
  const shareEnabled = 
    app?.features?.shortLinks !== false && 
    platformConfig?.featuresMap?.shortLinks !== false;
  
  const toolsFeatureEnabled = platformConfig?.featuresMap?.tools !== false;
  
  const magicPromptEnabled = app?.features?.magicPrompt?.enabled === true;
  
  const magicModel = app?.features?.magicPrompt?.model;
  const magicPrompt = app?.features?.magicPrompt?.prompt;
};
```

### After: Clean utility methods
```javascript
const AppChat = ({ app }) => {
  const featureFlags = useFeatureFlags();
  
  // Clean, readable checks
  const shareEnabled = featureFlags.isBothEnabled(app, 'shortLinks', true);
  const toolsFeatureEnabled = featureFlags.isEnabled('tools', true);
  const magicPromptEnabled = featureFlags.isAppFeatureEnabled(app, 'magicPrompt.enabled', false);
  const magicModel = featureFlags.getAppFeatureValue(app, 'magicPrompt.model', null);
  const magicPrompt = featureFlags.getAppFeatureValue(app, 'magicPrompt.prompt', '');
};
```

## Benefits

1. **Cleaner code** - No more complex conditional chains
2. **Consistency** - Single pattern across the codebase
3. **Discoverability** - IDE autocomplete for methods
4. **Type safety** - Clear method signatures
5. **Maintainability** - Changes in one place
6. **Default handling** - Explicit default values
7. **Testability** - Easy to unit test

## Performance

The utility has minimal performance overhead:
- Same number of property accesses as before
- React hook memoizes the instance
- No external dependencies
- Lightweight implementation

## Testing

```javascript
import { FeatureFlags } from '../shared/featureFlags.js';

describe('FeatureFlags', () => {
  const platformConfig = {
    featuresMap: {
      tools: true,
      promptsLibrary: false
    }
  };
  
  const app = {
    features: {
      magicPrompt: {
        enabled: true,
        model: 'gpt-4',
        prompt: 'Enhance this prompt...'
      },
      shortLinks: true
    }
  };
  
  it('should check platform feature', () => {
    const flags = new FeatureFlags(platformConfig);
    expect(flags.isEnabled('tools', true)).toBe(true);
    expect(flags.isEnabled('promptsLibrary', true)).toBe(false);
  });
  
  it('should check app feature', () => {
    const flags = new FeatureFlags(platformConfig);
    expect(flags.isAppFeatureEnabled(app, 'magicPrompt.enabled', false)).toBe(true);
  });
  
  it('should get app feature value', () => {
    const flags = new FeatureFlags(platformConfig);
    expect(flags.getAppFeatureValue(app, 'magicPrompt.model', null)).toBe('gpt-4');
  });
});
```

## See Also

- [Feature Registry](../../server/featureRegistry.js) - Server-side feature definitions
- [Feature Configuration](../../contents/config/features.json) - Runtime feature flags
- [Concept Document](../../concepts/2026-02-17%20Feature%20Flag%20Utility%20Encapsulation.md) - Design decisions
