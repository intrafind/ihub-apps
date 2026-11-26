# Breaking Changes — Unreleased

## Text Watermark: Detector Credentials Must Be a Token or an OAuth2 Client

A detector credential of the text watermark must now be a bearer token (or an opaque secret) or
an OAuth2 client. A credential of another type, such as basic authentication or an API key
header, is refused: the detector counts as not configured, and **Check an output** and the
self-test say so. Until now iHub sent the first secret of such a credential as a bearer token.
The documentation named only bearer tokens.

**Before upgrading:** In **Admin → Models → Output marking**, look at the detector credential of
the models whose key iHub holds. Replace one of another type with a bearer credential holding
the same token, or with an OAuth2 client.
