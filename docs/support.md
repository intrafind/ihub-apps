---
description: "Where to get help with iHub Apps, what to collect before you ask, and how to monitor your own deployment."
audience: admin
type: how-to
---

# Getting Support

This page lists where to ask for help, what to prepare so a question can be answered quickly, and how you can monitor your own installation.

## Where to get help

| Channel | Use it for |
|---------|-----------|
| **This documentation** | Start here. Admins can read the same pages inside iHub under **Admin → Documentation** (`/admin/docs`). See also [Troubleshooting](troubleshooting.md) and the [FAQ](ihub-faq-en.md). |
| **GitHub issues** | Bug reports and feature requests: [github.com/intrafind/ihub-apps/issues](https://github.com/intrafind/ihub-apps/issues). The README points to this channel. |
| **IntraFind support** | Questions about running iHub, enterprise support, SLAs, warranties, custom features and project-specific consulting: [support@intrafind.com](mailto:support@intrafind.com). The terms that apply to you, including response times, are defined in your own contract or license agreement, not in this repository. |

The repository does not document a response-time commitment or a hosted status page for iHub. Do not assume any; ask your IntraFind contact.

Do not post security-sensitive details, secrets or customer data in a public issue.

## Before you ask

Work through this list and put the results in your report.

1. **Check the docs.** Search [Troubleshooting](troubleshooting.md), the [FAQ](ihub-faq-en.md) and the page for the feature in question.
2. **Find your version.** See [Find the running version](#find-the-running-version).
3. **Check the server is healthy.** Run `npm run health` (a `curl -f` against `http://localhost:3000/api/health`) or call the health endpoint of your deployment. See [Health endpoint](#health-endpoint).
4. **Describe how to reproduce the problem.** Give the exact steps, the app, model and provider involved, whether it happens for every user or one, and what you expected instead.
5. **Collect logs.** See [Collect logs](#collect-logs).
6. **Redact secrets.** Remove API keys, tokens, passwords, cookies (`authToken`), the contents of `contents/.encryption-key`, and personal data from everything you attach. Platform config secrets are encrypted in `platform.json`, but logs, screenshots and pasted JSON can still contain secrets.

## Find the running version

- **Admin UI:** the **Version** card on the admin dashboard shows the running version and an update badge if a newer one exists. See [Admin Interface](admin-ui.md).
- **Health endpoint:** the `version` field of `GET /api/health`. It is read from the `npm_package_version` environment variable, which is set when the server is started through `npm`. If the server is started another way, the field falls back to `1.0.0` and is not reliable. Use the admin dashboard instead.
- **Source checkout:** the `version` field in `package.json`.

## Collect logs

iHub writes logs with Winston. The default level is `info`. Details, including all options, are in [Logging](logging.md).

- **Console output:** the output of the server process (for Docker, the container logs).
- **Log file:** if file logging is enabled (`logging.file.enabled` in `contents/config/platform.json`, off by default), logs are written to `logs/app.log` by default.
- **Raise the level** to reproduce a problem in more detail. In the admin UI, open **Admin → System**, find **Logging Configuration** and click a level. The change applies at once and needs no restart. Alternatively set `logging.level` in `contents/config/platform.json`. Levels from least to most verbose: `error`, `warn`, `info`, `http`, `verbose`, `debug`, `silly`. Use `debug` for a reproduction, then set it back to `info`, because the higher levels are very verbose.
- **Narrow the logs.** Log entries are JSON by default and carry a `component` field and, for requests, `userId` and `ip`. Attach only the lines around the time of the problem, for example `jq 'select(.component == "ChatService")' logs/app.log`.

## What to attach

- iHub version and how it is deployed (binary, Docker, source, subpath or root).
- Node.js version and operating system. The **Host** section on **Observability → System Resources** (`/admin/system-resources`) shows both. See [System Resources](admin-ui.md#system-resources).
- The output of `/api/health`.
- The reproduction steps and the log lines from the time of the problem, with secrets redacted.
- The relevant config file (for example the app or model JSON), with keys and secrets removed.
- The authentication mode in use (anonymous, local, OIDC, proxy, LDAP/NTLM) for sign-in problems.

## Monitor your own deployment

iHub does not ship a status page. If your users need one, the operator publishes it with whatever monitoring or status-page tool the organization already uses.

### Health endpoint

`GET /api/health` needs no authentication. It returns JSON, including:

- `status`: `OK` when the server answers.
- `timestamp`, `version` and `environment`.
- `storage`: `{ "ready": true|false, "provider": "<name>" }`. If the storage backend failed to start, `status` still says `OK`, so a monitor that only checks the status code or `status` will miss it. Alert on `storage.ready` being `false` as well.
- `basePathConfig`, `requestPath`, `requestUrl` and `relativePath`: information about the base path, useful for subpath deployments.

If iHub runs under a base path, the endpoint is below it, for example `/ihub/api/health`.

Point an uptime monitor at this URL and publish the result on a page you control. The endpoint is a liveness and storage check only. It does not test model providers, LDAP, OIDC or other integrations. The platform status panel on the admin dashboard lists installed integrations and free disk space, and [System Resources](admin-ui.md#system-resources) has detailed disk usage. See [Admin Interface](admin-ui.md).

## Release notes and changelog

- **In iHub:** **What's New** (`/admin/changelog`) lists releases that shipped something worth noting, newest first, and flags the releases since your last upgrade. See [Admin Interface](admin-ui.md#whats-new).
- **In the repository:** the release notes are in `docs/releases/<version>/`. Unreleased changes are collected in `docs/releases/next/`.
- **Downloads:** [GitHub Releases](https://github.com/intrafind/ihub-apps/releases).

Check the release notes for your version, and for newer ones, before you report a bug. It may already be fixed.
