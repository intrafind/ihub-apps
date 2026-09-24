# Third-party integrations — issue drafts (2026-09-24)

Drafts for an epic and 19 GitHub issues that plan new third-party integrations: connectors that let apps work with the systems our customers use, through per-user or shared connections, model-callable actions and event triggers. MCP servers are a separate track and not covered here.

These are **issue drafts, not filed yet**. When this folder was written, the GitHub connector in the authoring session rejected every issue call with "Bad credentials", so the drafts were committed here to keep them.

## Contents

| File | Issue |
| --- | --- |
| `00-epic.md` | [Epic] Third-party integrations: connections, actions and triggers |
| `01-framework.md` | Shared connection framework: per-user OAuth and shared credentials, one connect/reconnect flow, user-confirmed write actions |
| `02-triggers.md` | Integration triggers: start workflows and scheduled tasks on external events |
| `03-outlook-mail.md` | Microsoft 365 Outlook Mail tools |
| `04-outlook-calendar.md` | Microsoft 365 Outlook Calendar tools |
| `05-teams.md` | Microsoft Teams as a data source and target (messages, channels, transcripts, posting) |
| `06-planner-todo.md` | Microsoft Planner and To Do task tools |
| `07-powerbi.md` | Power BI semantic models and reports |
| `08-cloud-files.md` | Model-callable search, read and save for OneDrive/SharePoint, Google Drive, Nextcloud |
| `09-confluence.md` | Confluence (Cloud and Data Center) |
| `10-jira.md` | Jira: create/update issues and Data Center / Server support |
| `11-slack.md` | Slack |
| `12-deepl.md` | DeepL translation, glossaries, document translation, writing improvement |
| `13-google-workspace.md` | Google Workspace: Gmail, Calendar, Docs, Sheets, Slides |
| `14-sql.md` | Read-only SQL data sources |
| `15-retrieval-index.md` | Bring-your-own retrieval index (vector databases and search indexes) |
| `16-service-desk.md` | ServiceNow and Zendesk |
| `17-crm.md` | CRM: Dynamics 365 and HubSpot (shared contract with Salesforce) |
| `18-personio.md` | Personio HR, scoped per user |
| `19-openapi-packages.md` | Ready-made tool packages on the OpenAPI tool runner |

## Draft format

Each file starts with two header lines, then `---`, then the issue body:

```
TITLE: <issue title>
LABELS: <comma-separated labels>
---
<issue body in GitHub markdown>
```

The bodies use three placeholders that get resolved while filing:

- `#EPIC` → the number of the issue created from `00-epic.md`
- `#FRAMEWORK` → the number of the issue created from `01-framework.md`
- `SUBISSUES` (only in `00-epic.md`) → a grouped checklist of the created sub-issue numbers

## Filing order

1. Create `00-epic.md` as it is. Placeholders stay until step 4.
2. Create `01-framework.md`, replacing `#EPIC`.
3. Create `02`–`19`, replacing `#EPIC` and `#FRAMEWORK`.
4. Edit the epic: replace `SUBISSUES` with the checklist, grouped as Foundation, Microsoft 365, Atlassian, Communication and language, Google, Data, Business systems, API packages.
5. Once the issues exist, delete this folder or mark it as filed.
