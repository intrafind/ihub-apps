Architectural and Design Enhancements
Improve the overall structure and design patterns.
4.1. Split serverHelpers.js
Issue: This file has become a "catch-all" for various unrelated utilities (middleware setup, prompt processing, API key verification, SSE).
Action: Split the file into more focused modules.
middleware/setup.js: Move setupMiddleware and checkContentLength here.
services/PromptService.js: Move resolveGlobalPromptVariables and processMessageTemplates here. This logic is complex enough to warrant its own service.
utils/ApiKeyVerifier.js: This already exists as a class but is exported from serverHelpers. Make it a standalone export from its own file.
sse.js: Keep sendSSE and related client management here.
4.2. Promote Complex Tools to Services
Files: tools/iFinder.js, tools/entraPeopleSearch.js.
Issue: These files define classes and expose multiple methods, making them more like services than simple, single-purpose tools. Grouping them in tools/ alongside simple functions is inconsistent.
Action:
Create a new directory: services/integrations/.
Move iFinder.js to services/integrations/iFinderService.js.
Move entraPeopleSearch.js to services/integrations/EntraService.js.
Update the tool definitions in tools.json (or wherever they are configured) to point to methods on these services.
4.3. Centralize User-Specific ETag Generation
Issue: The logic to generate a user-specific ETag for filtered resources (apps, models, prompts) is duplicated across routes/generalRoutes.js, routes/modelRoutes.js, and routes/toolRoutes.js.
Action: Move this logic into configCache.js.
Create methods like getAppsForUser(user) in configCache.js.
This method would get the raw apps, filter them based on user permissions, and then generate and cache a user-specific ETag based on the filtered result.
The route handlers would then become much simpler, just calling this one method.