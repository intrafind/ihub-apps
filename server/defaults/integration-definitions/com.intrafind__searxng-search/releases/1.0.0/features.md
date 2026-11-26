# SearXNG 1.0.0

- First version of the built-in SearXNG engine (`type: web-search`), installed once as `searxng`. It searches through a SearXNG instance you run yourself, so the search traffic of iHub goes to your gateway and not to a search vendor's API. SearXNG still forwards each query to the engines you enabled in it (Google, Bing, Brave, and so on); which of them see it is your decision, made in the instance.
- The instance URL (`instanceUrl`) is required. The instance must have `json` in `search.formats` of its `settings.yml`.
- SearXNG has no API key. `authorizationRef` is an optional credential for a reverse proxy in front of the instance: it is sent as a `Bearer` token, or as it is when it starts with `Basic `.
- One action, `search`, under the tool id `searxngSearch`, with the same parameters as the other engines. Apps use it when `websearch.provider` is `searxng`, or on `auto` after Brave, Staan and Qwant.
- Hits stay private in shared chats, because an instance may search an intranet as well.
- **Test** checks the URL and the credential as entered and runs one live search. It names the usual causes: JSON output off (HTTP 403), a wrong path (404), the limiter (429), an engine that does not answer.
