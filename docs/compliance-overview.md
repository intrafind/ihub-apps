---
description: "Where iHub keeps data, what leaves the system, and which controls support a security or procurement review."
audience: admin
type: concept
---

# Compliance Overview

This page is a starting point for a security officer or procurement team. It lists the controls iHub Apps provides and where each one is described. It describes features. It does not certify anything, and it is not legal advice: whether a deployment meets GDPR, the EU AI Act or an accessibility law depends on how you host, configure and use it.

## How iHub handles data

- **Self-hosted.** You run iHub on your own infrastructure (npm, Docker, Kubernetes or a binary, see [Security](security.md#deployment-security)).
- **No database.** Configuration and runtime data are JSON files under `contents/` (for example `contents/config/`, `contents/data/`). You back up, encrypt and delete them with your own file-system and storage tools. See [PII Data Handling](pii-data-handling.md) for the full list of paths.
- **Outbound traffic goes where you point it.** iHub sends data to the models, tools and integrations you configure, such as an LLM provider or a connected system like iFinder or Jira. Telemetry is off by default. Prompts and completions are only added to telemetry when you switch on `telemetry.events.includePrompts` or `includeCompletions`. See [PII Data Handling](pii-data-handling.md#third-party-data-flow).
- **Outbound TLS.** Certificate verification is on by default (`ssl.ignoreInvalidCertificates` is `false` and `ssl.domainWhitelist` is empty in `platform.json`). The whitelist is an exception for hosts with a private CA; it lowers verification for those hosts, so keep it as short as possible. See [SSL Certificates](ssl-certificates.md).

## Controls at a glance

| Topic | What iHub does | Where configured | Details |
| --- | --- | --- | --- |
| Data location | Stores everything as files under `contents/` on your server. No external database. | Your deployment and file system | [PII Data Handling](pii-data-handling.md) |
| Personal data inventory | Lists each category of personal data, its storage path, default retention and the switch that disables or anonymizes it. | `platform.json` | [PII Data Handling](pii-data-handling.md#summary) |
| Chat retention | Temporary chats are deleted after `chats.temporaryRetentionHours` (default 24). Kept chats follow `chats.retentionDays` (default 90). | `platform.json`, Admin chat history settings | [PII Data Handling](pii-data-handling.md#2-chat-content), [Chat Persistence](chat-persistence.md) |
| Other retention | Audit log (`audit.retentionDays`, default 365), usage events, rollups, feedback and provenance records each have their own retention setting. | `platform.json` | [PII Data Handling](pii-data-handling.md#privacy-controls), [Usage Reporting](usage-reporting.md) |
| IP and identifier privacy | IP addresses in audit entries and log lines can be masked or dropped. Usage tracking can hash user and conversation ids. Email-shaped audit identifiers are masked by default. | `audit.anonymizeIp`, `logging.anonymizeIp`, `features.usageTrackingMode`, `audit.includeEmail` | [PII Data Handling](pii-data-handling.md#recommended-privacy-first-configuration) |
| Data subject requests | The reference page maps access, erasure and related requests to the files and settings involved. | See the page | [PII Data Handling](pii-data-handling.md#data-subject-rights-gdpr-art-15-22) |
| Encryption at rest | Secrets in the configuration (OIDC, LDAP, NTLM, credential profiles, integration secrets) are encrypted with AES-256-GCM. The key is in `contents/.encryption-key` or the `TOKEN_ENCRYPTION_KEY` environment variable. The encryption described in the linked pages covers configuration secrets and credentials only. For chat, usage and other files under `contents/`, use disk or volume encryption. | `contents/.encryption-key`, `TOKEN_ENCRYPTION_KEY` | [Security](security.md#secret-encryption-at-rest), [Encryption Key Management](encryption-key-management.md) |
| Encryption in transit | Serve iHub over HTTPS, either through a TLS-terminating reverse proxy (recommended) or with `SSL_CERT` / `SSL_KEY`. | Reverse proxy or environment variables | [SSL/HTTPS Setup](ssl-https-setup.md), [Security](security.md#https-configuration) |
| Authentication | Anonymous, local, OIDC, LDAP, NTLM and proxy modes. Local passwords are hashed with bcrypt. Sessions use a signed JWT cookie (`auth.sessionTimeoutMinutes`, default 480). | `platform.json`, Admin auth settings | [Authentication Architecture](authentication-architecture.md), [Security](security.md#authentication--authorization) |
| Authorization | Group-based access to apps, models and admin functions, with group inheritance. | `groups.json`, Admin groups | [Authentication Architecture](authentication-architecture.md), [Security](security.md#authorization-system) |
| Audit log | Records mutating admin actions (actor, action, resource, result, request id, IP) to daily files under `contents/data/audit-log/`. Chat and inference traffic is not part of it. | `audit.*` in `platform.json`, Admin Observability, Audit Log | [PII Data Handling](pii-data-handling.md#4-audit-log), [Admin UI](admin-ui.md#audit-log) |
| Logging | Structured logs to stdout, optional rotating file, automatic redaction of passwords and tokens, request context (user, IP). | `logging.*` in `platform.json`, Admin Observability, Logging | [Logging](logging.md) |
| Telemetry | Optional OpenTelemetry export. Off by default. | `telemetry.*` in `platform.json` | [Telemetry](telemetry.md#privacy--security) |
| Record of an answer | For each stored answer, a record of the prompts, tool calls and model settings that produced it. It is kept as long as the chat. | `chats.evidence` in `platform.json` | [Chat Evidence Record](chat-evidence.md) |
| EU AI Act, Article 50 | Support for transparency duties: an AI-disclosure guardrail in model calls, a first-turn notice, an AI-use acknowledgement, and provenance records for AI output. One audited master switch turns these off. | Admin EU AI Act page, `aiDisclosure`, `aiAcknowledgement`, `provenance` in `platform.json` | [EU AI Act](ai-act.md), [Provenance Records](provenance.md) |
| Accessibility | Targets WCAG 2.2 AA and tracks EN 301 549, BITV 2.0 and BFSG. Automated checks (eslint jsx-a11y, axe-core) run in CI. The page lists known gaps, including that screen-reader results are not yet recorded. | Not configurable | [Accessibility](accessibility.md) |
| Vulnerability reporting | Reports go to the contact in `SECURITY.md` in the repository root. | Repository | `SECURITY.md` |
| Licensing | iHub Apps is under the license in `LICENSES/LicenseRef-iHub-Apps.txt` (a BSD 3-Clause variant with mandatory attribution). Source files carry SPDX headers, `REUSE.toml` covers the rest, and third-party material (for example the Inter and JetBrains Mono fonts under OFL-1.1) keeps its own license. CI runs `reuse lint`. | Repository | `REUSE.toml`, `LICENSES/` |

## What you are responsible for

iHub gives you the controls above. The following stay with you:

- **Hosting.** The servers, network, TLS certificates, backups, disk or volume encryption, access to `contents/`, and protection of the encryption key.
- **Model and integration providers.** Contracts, data processing terms, data location and retention at each LLM provider or connected system you enable. Prompts and files leave iHub for these providers when you configure them. With text recognition set up, the pages of images and scanned PDFs go to its engine when they are added to a project, and to a chat where text recognition is switched on: to the provider of the model (`platform.ocr.modelId`), or to the service of the OCR integration picked as the engine (`platform.ocr.engine`, e.g. your own iFinder OCR service); see [Projects → Images and scanned PDFs](projects.md#images-and-scanned-pdfs).
- **Retention choices.** The defaults are a starting point. Set retention for chats, audit log, usage data, feedback and provenance records to match your own policy.
- **Identity.** Your identity provider or directory, and who you put in admin groups.
- **AI Act wording and policy.** The notice text, the AI-use statement and policy link, and which models you declare as watermarked or marked by their provider.
- **Your own assessment.** Any data protection impact assessment, records of processing, or legal review for your use of iHub.

## Related pages

- [Security](security.md)
- [PII Data Handling](pii-data-handling.md)
- [EU AI Act](ai-act.md)
- [Accessibility](accessibility.md)
