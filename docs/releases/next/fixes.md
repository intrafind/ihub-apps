# Fixes — Unreleased

## OpenAPI Tools: Array Parameters

Array query parameters of OpenAPI tools are now sent the way the document declares them
(repeated by default, comma-joined for `explode: false`) instead of always comma-joined, which
APIs such as CKAN rejected. A tool may also set `openapi.arrayStyle` to `json-list`.

