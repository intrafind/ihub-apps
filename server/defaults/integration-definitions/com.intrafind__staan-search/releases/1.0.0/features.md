# Staan 1.0.0

- First version of the built-in Staan engine (`type: web-search`), installed once as `staan`.
- The API key is a credential reference (`apiKeyRef`); `STAAN_API_KEY` applies when none is set.
- One action, `search`, under its historical tool id `staanSearch`. Apps use it when `websearch.provider` is `staan`, or on `auto` when it is the first engine the user may use.
- **Test** reports where the key comes from and runs one live search with the values as entered.
