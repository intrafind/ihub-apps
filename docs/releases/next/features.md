# Features — Unreleased

## Container Image: Signed SBOM and Vulnerability Report

The container image on `ghcr.io/intrafind/ihub-apps` now carries Trivy's SBOM and Trivy's
vulnerability report as signed attestations, so you can check what an image contains and what was
known about it at release time without scanning it yourself.

- The CycloneDX SBOM can be imported into tools such as Dependency-Track.
- The vulnerability report lists Trivy's findings of every severity on the day the image was
  built, including waived findings marked as suppressed. CVEs published later are not in it.
- Both are verified and downloaded with `gh attestation verify --predicate-type …`; the commands
  are in the security documentation under "Verifying a Release".
- The image keeps its existing BuildKit SBOM and build provenance.

## Apps: Use All Integrations and All Skills

An app can now use every integration and every skill, including ones installed later, so a new
MCP server, catalog integration or skill reaches the app without editing it. Single integrations
can still be configured or left out.

- **Admin → Apps → Edit → Integrations → Use all integrations** (`"integrations": { "*": {} }`)
  binds every integration that gives the model tools: MCP servers, agents, catalog integrations,
  iFinder and the people directories. Web search, storage providers and iAssistant keep their own
  panels and are not included.
- An integration the app also binds by itself keeps its own settings (actions, Required, scopes);
  **Exclude from "All integrations"** leaves one out (`"*": { "exclude": ["jira"] }`, also by
  definition id or `type:…`). "All integrations" never hides the app.
- **Admin → Apps → Edit → Skills → All skills** (`"skills": ["*"]`) offers every skill.
- The user's groups still decide which integrations and skills a user gets.

See [Apps → Integrations](../../apps.md#integrations-binding-an-installed-integration) and
[Skill Settings](../../apps.md#skill-settings).
