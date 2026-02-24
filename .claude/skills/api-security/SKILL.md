---
name: api-security
description: Guide for securing API endpoints with proper input validation, path traversal prevention, and parameter sanitization. Auto-invoked when working on route handlers or API endpoints.
user-invocable: false
---

# API Security — Input Validation & Path Safety

All input validation and path security functions live in **`server/utils/pathSecurity.js`**. Never write inline validation — always use these centralized utilities.

## Function Reference

### ID Validation

| Function | Signature | Use When |
|----------|-----------|----------|
| `isValidId` | `(id) → boolean` | Checking any user-supplied ID (app, model, source, tool, prompt, page, renderer, skill, group, provider, client) |
| `validateIdForPath` | `(id, idType, res?) → boolean` | Express handler — sends 400 and returns `false` on invalid. Pass `res` to auto-respond |
| `validateIdsForPath` | `(ids, idType, res) → string[] \| false` | Batch validation. Accepts comma-separated string, array, or `'*'` wildcard |

### Language Code Validation

| Function | Signature | Use When |
|----------|-----------|----------|
| `isValidLanguageCode` | `(lang) → boolean` | Validating BCP-47 codes like `en`, `de`, `en-US`, `pt-BR` |
| `sanitizeLanguageCode` | `(lang, fallback?) → string` | Coercing a query param to a safe language code (defaults to `'en'`) |
| `validateLanguageKeys` | `(obj) → boolean` | Validating all keys of a language-keyed object (e.g., `{ en: "...", de: "..." }`) |

### Path Traversal Prevention

| Function | Signature | Use When |
|----------|-----------|----------|
| `resolveAndValidatePath` | `(filePath, baseDir) → string \| null` | Building any file path from user input. Returns absolute path or `null` if it escapes `baseDir` |
| `resolveAndValidateRealPath` | `async (filePath, baseDir) → string \| null` | Same as above but follows symlinks first via `fs.realpath()`. Use for skill resources or any symlink-sensitive context |
| `sanitizeRelativePath` | `(filePath) → string` | Stripping leading slashes from relative paths before passing to `resolveAndValidatePath` |

## Route Handler Checklist

When creating or modifying any route that accepts user input:

1. **Validate `:param` IDs first** — call `validateIdForPath(id, type, res)` as the very first operation in the handler. Return immediately if it returns `false`.

```js
app.get('/api/things/:thingId', async (req, res) => {
  if (!validateIdForPath(req.params.thingId, 'thing', res)) return;
  // ... safe to proceed
});
```

2. **Validate language query params** — use `sanitizeLanguageCode`:

```js
const lang = sanitizeLanguageCode(req.query.lang);
```

3. **Validate language-keyed request bodies** — use `validateLanguageKeys`:

```js
if (Object.keys(content).length > 0 && !validateLanguageKeys(content)) {
  return res.status(400).json({ error: 'Invalid language code in content keys' });
}
```

4. **Construct file paths safely** — ALWAYS use `resolveAndValidatePath`:

```js
const fullPath = resolveAndValidatePath(userInput, baseDir);
if (!fullPath) {
  return res.status(400).json({ error: 'Invalid path' });
}
```

5. **Validate stored config paths too** — data in config files could be tampered with:

```js
const abs = resolveAndValidatePath(page.filePath[lang], contentsBase);
if (!abs) {
  logger.warn(`Skipping file with invalid stored path: ${page.filePath[lang]}`);
  continue;
}
```

6. **ZIP extraction** — validate each entry with `resolveAndValidatePath` to prevent ZIP slip:

```js
const destPath = resolveAndValidatePath(normalizedEntry, targetDir);
if (!destPath) {
  throw new Error(`Zip path escapes target directory: ${entry}`);
}
```

## Anti-Patterns — Never Do These

| Bad Pattern | Why It's Wrong | Use Instead |
|-------------|---------------|-------------|
| `path.resolve(base, userInput)` without check | No boundary enforcement | `resolveAndValidatePath(userInput, base)` |
| `resolved.startsWith(baseDir)` without `+ path.sep` | `"/contents-evil"` passes the check for `"/contents"` | `resolveAndValidatePath` (handles this internally) |
| Inline regex `/^[a-zA-Z0-9_-]+$/` | Duplicated, inconsistent, easy to get wrong | `isValidId(id)` |
| `path.normalize(p).replace(/^(\.\.)+/, '')` | Fragile regex, doesn't cover all traversal vectors | `resolveAndValidatePath(p, baseDir)` |
| `!p.includes('..') && !path.isAbsolute(p)` | Misses encoded sequences, Unicode tricks | `resolveAndValidatePath(p, baseDir)` |
| `path.relative(base, target).startsWith('..')` | Doesn't handle all edge cases consistently | `resolveAndValidatePath(target, base)` |

## FileSystemHandler Pattern

For classes that repeatedly resolve paths against a base directory, use a private helper:

```js
import { resolveAndValidatePath, sanitizeRelativePath } from '../utils/pathSecurity.js';

class MyHandler {
  _resolveSafePath(relativePath) {
    const cleaned = sanitizeRelativePath(relativePath);
    const resolved = resolveAndValidatePath(cleaned, this.basePath);
    if (!resolved) {
      throw new Error(`Access denied: path ${relativePath} is outside allowed directory`);
    }
    return resolved;
  }
}
```

## Key Files

- **Centralized utility**: `server/utils/pathSecurity.js`
- **Tests**: `server/tests/pathSecurity.test.js`, `server/tests/pathSecurity-models.test.js`
- **Example routes using it**: `server/routes/admin/pages.js`, `server/routes/admin/skills.js`, `server/routes/modelRoutes.js`, `server/routes/pageRoutes.js`
