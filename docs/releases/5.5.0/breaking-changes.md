# Breaking Changes — 5.5.0

## `config/tools.json` Is Removed

Tool configuration no longer supports the shared `contents/config/tools.json` array. Every tool
now lives in its own file under `contents/tools/`, and there is no fallback to the old file.

- A configuration migration runs automatically on upgrade: it splits any existing
  `contents/config/tools.json` into individual `contents/tools/<toolId>.json` files and deletes
  the old file. No manual action is required.
- `deepResearch`, `answerReducer`, `evaluator`, `queryRewriter`, and `researchPlanner` have been
  retired and are removed by the same migration, whether they were still in the legacy file or
  already split into their own file.
- Custom tools you added directly to `config/tools.json` are preserved — they're carried over into
  their own file with the same ID.

**Before upgrading:** No action needed; the migration handles the conversion automatically. If you
have external tooling that reads or writes `contents/config/tools.json` directly, update it to
manage individual files under `contents/tools/` instead.

## Electron Desktop App Target Removed

The `npm run electron:dev` and `npm run electron:build` scripts, the `electron/` source directory,
and the `electron`/`electron-builder` dev dependencies have been removed. This target never
produced a working packaged app — the desktop build had no valid entry point and could not reach
the local API server once packaged — so no functioning deployment is affected.

- Use the Progressive Web App (installable from the browser), the standalone binary, Docker, or
  npm for deployment instead.

**Before upgrading:** No action needed. If you had scripts or documentation referencing
`electron:dev`/`electron:build`, remove those references — the commands no longer exist.

## Web Content Extractor Tool Now Uses the SSRF Allowlist, Not the SSL Allowlist

The `webContentExtractor` tool (used for reading web pages during chats) blocked requests to
private/internal IP addresses using a weaker check than the rest of the platform, and let admins
bypass that block only via `ssl.domainWhitelist` — a setting meant for certificate validation, not
SSRF protection. Both are now fixed: the tool uses the same private-IP classifier as every other
outbound request path (covering carrier-grade NAT and additional IPv6 address forms it previously
missed), and the bypass now reads from the dedicated `ssrf.allowedHosts` setting.

- If you relied on `ssl.domainWhitelist` to let `webContentExtractor` reach an internal host, add
  that host to `ssrf.allowedHosts` in Admin → Platform Settings instead.

**Before upgrading:** Move any hosts needed for `webContentExtractor` from `ssl.domainWhitelist` to
`ssrf.allowedHosts`.
