# Brave Search 1.0.0

- First version of the built-in Brave Search engine (`type: web-search`), installed once as `brave`.
- The API key is a credential reference (`apiKeyRef`); `BRAVE_SEARCH_API_KEY` applies when none is set.
- One action, `search`, under its historical tool id `braveSearch`. Apps use it when `websearch.provider` is `brave`, or on `auto` when it is the first engine the user may use.
- **Test** reports where the key comes from and runs one live search with the values as entered.
