# Qwant 1.0.0

- First version of the built-in Qwant engine (`type: web-search`), installed once as `qwant`. It needs no API key and no settings.
- One action, `search`, under its historical tool id `qwantSearch`. Apps use it when `websearch.provider` is `qwant`, or on `auto` when it is the first engine the user may use.
- **Test** runs one live search from this server; Qwant blocks many data-centre IP addresses, and the test says so.
