# Fixes — 5.5.3

## Apps Called Over MCP Now Honour Their Prompt and Variables

An app invoked headlessly — through the MCP gateway, an A2A skill, or as a tool from another app —
ignored its own prompt template and every variable the caller passed. Only the system prompt and the
raw message reached the model, so the Translator asked for German answered in Spanish, and the Email
Composer received a recipient, subject and tone it never saw.

The app's prompt is now attached to the outgoing message on these paths, the same way the web UI
already did it, so `{{language}}`, `{{content}}` and every other placeholder are filled in. This
affects every variable-driven app: Translator, Email Composer, Meeting Assistant, Social Media, and
any app whose MCP tool schema advertises required arguments.

## The Docker Image Ships Without Known High-Severity Vulnerabilities

A scan of the published container image reported nine high-severity findings, most of them in
software the application never runs. The image is now built so those components are patched or
absent.

- Pending Alpine security updates are applied while the image is built, so OS libraries such as
  `libssl3`/`libcrypto3` no longer lag behind fixes that Alpine has already published.
- The npm CLI is removed from the production image. The container only ever runs `node`, and npm
  brought its own bundled dependency tree (`tar`, `undici`, `brace-expansion`, `ip-address`) that
  could not be patched from this repository. `docker exec` into the container therefore no longer
  has `npm` or `npx` available; the development image still has both.
- The bundled YAML parser used by the docs, OpenAPI and front-matter code paths is updated to a
  patched release.

The image scan in CI also reports severities correctly now: it previously counted every
high-severity finding as critical, so release builds failed with a "critical vulnerabilities found"
message even when there were none.
