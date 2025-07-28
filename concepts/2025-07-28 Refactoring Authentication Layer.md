Major Refactoring of the Authentication Layer
This layer has the most significant code duplication. Centralizing the common logic will dramatically improve maintainability.
2.1. Create a Central TokenService
Issue: The generateJwtToken function is duplicated with minor variations across ldapAuth.js, ntlmAuth.js, teamsAuth.js, and oidcAuth.js. The createToken function in localAuth.js is also very similar.
Action: Create a new file utils/tokenService.js.
Create a single, unified generateJwt(user, options = {}) function in this service.
This function should take the user object and options like expiresInMinutes.
It will read the JWT_SECRET from the central config.
Refactor all auth middleware files to import and use this single function.
2.2. Unify User Persistence Logic
Issue: The logic in validateAndPersistProxyUser (proxyAuth.js) and validateAndPersistOidcUser (oidcAuth.js) is nearly identical. Furthermore, createOrUpdateProxyUser is just a wrapper around createOrUpdateOidcUser.
Action:
In utils/userManager.js, rename createOrUpdateOidcUser to a more generic name like createOrUpdateExternalUser.
Refactor proxyAuth.js to call this new generic function directly, removing createOrUpdateProxyUser.
Create a single validateAndPersistExternalUser(externalUser, platformConfig) function in utils/userManager.js that contains the shared logic from the proxyAuth and oidcAuth files.
Refactor both proxyAuth.js and oidcAuth.js to call this new centralized validation function.
2.3. Consolidate Authorization and Group Logic
Issue: Logic for enhancing users with groups (enhanceUserGroups), mapping external groups, and calculating permissions is spread out or called from multiple places.
Action: Ensure all this logic resides within utils/authorization.js and is used consistently.
The enhanceUserGroups function is a great utility. Make sure it's the only place where the authenticated group and provider-specific default groups are added.
Refactor ldapAuth.js and ntlmAuth.js to remove their manual group mapping logic and instead use mapExternalGroups from utils/authorization.js.
2.4. Generalize Resource Access Middleware
Issue: In middleware/authRequired.js, the appAccessRequired and modelAccessRequired functions are identical except for the resource name (appId vs modelId, apps vs models).
Action: Merge them into a single, higher-order function.
Generated javascript
// In middleware/authRequired.js

function resourceAccessRequired(resourceType) {
return function(req, res, next) {
const resourceId = req.params[`${resourceType}Id`]; // e.g., req.params.appId
const permissionsKey = `${resourceType}s`; // e.g., 'apps'

    if (req.user && req.user.permissions) {
      const allowed = req.user.permissions[permissionsKey] || new Set();

      if (!allowed.has('*') && !allowed.has(resourceId)) {
        return res.status(403).json({
          error: 'Access denied',
          code: `${resourceType.toUpperCase()}_ACCESS_DENIED`,
          message: `You do not have permission to access ${resourceType}: ${resourceId}`
        });
      }
    }
    next();

};
}

// Then you can export them like this:
export const appAccessRequired = resourceAccessRequired('app');
export const modelAccessRequired = resourceAccessRequired('model');
