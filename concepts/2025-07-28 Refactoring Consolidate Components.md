Consolidate Duplicated Components
Outside of auth, other areas have significant duplication.
3.1. Abstract Search Tools
Files: tools/braveSearch.js, tools/tavilySearch.js.
Issue: Both are simple wrappers for a search API. Their core logic is the same: take a query, call an API, and format the results.
Action: Create a WebSearchService.
Create services/WebSearchService.js.
Define a base search method.
Implement BraveSearchProvider and TavilySearchProvider classes that conform to a common interface.
Create a single webSearch.js tool that uses the WebSearchService to perform a search, selecting the provider based on platform configuration. This makes adding a new search provider (e.g., Google) trivial.
3.2. Generalize Resource Loaders
Files: appsLoader.js, modelsLoader.js, promptsLoader.js.
Issue: These three files are almost identical. They all perform the same steps: load from a directory of JSON files, load from a legacy JSON array file, merge them, filter by enabled, and sort.
Action: Create a generic resource loader utility.
Create utils/resourceLoader.js.
Create a function createResourceLoader({ resourceName, legacyPath, individualPath, schema }).
This function would return an object with a loadAll() method that contains the duplicated logic.
Refactor the existing loader files to use this new factory function, reducing each file to just a few lines of configuration.
