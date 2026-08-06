# Group Hierarchy

## Overview

Adds support for hierarchical groups where one group can inherit the permissions of other groups. This allows admins to define base roles once and compose more specific groups without duplicating permissions.

## Key Files

- `contents/config/groups.json` – new `inherits` property per group
- `server/utils/authorization.js` – permission aggregation logic
- `server/configCache.js` – preload and resolve group hierarchy
- `docs/external-authentication.md` – document new group syntax

## Implementation Plan

1. **Extend groups configuration**
   - Add an optional `"inherits"` array to each group entry in `groups.json`.
   - Example:
     ```json
     "users": {
       "id": "users",
       "name": "Users",
       "inherits": ["authenticated"],
       "permissions": { /* ... */ }
     }
     ```
2. **Resolve hierarchy**
   - In `authorization.js` create `resolveGroupInheritance(groups)` which recursively merges permissions of all inherited groups into each group at load time.
   - Detect circular references and throw an error during startup.
3. **Update permission loading**
   - `loadGroupPermissions()` calls `resolveGroupInheritance()` before returning the config so permission sets already include inherited values.
   - Cached groups in `configCache.js` should also store the resolved result for quick access.
4. **Documentation**
   - Update authentication docs with instructions and examples for the `inherits` field.
5. **Migration**
   - Existing groups remain valid because `inherits` is optional. Admins can gradually introduce parent groups.

This approach keeps runtime checks minimal: permissions are expanded once at startup, and users still receive the union of permissions from all groups they belong to.
