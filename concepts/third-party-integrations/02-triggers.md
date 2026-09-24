TITLE: Integration triggers: start workflows and scheduled tasks when something happens in a connected system (new email, new ticket, new file)
LABELS: enhancement, backend, frontend
---
Part of #EPIC. Builds on #FRAMEWORK.

## Summary

Today a workflow starts on a schedule, through a manually configured webhook, or by hand. Many useful automations start with an event in another system instead:

- a new email in a folder;
- a new Jira issue in a project;
- a new file in a SharePoint folder;
- a new ServiceNow incident.

Connectors should offer **triggers** that watch for such events. Triggers use polling where no push API exists, and subscriptions where the system supports them. Each event starts a workflow or a scheduled-task run as the connection owner.

## Current state

- **Two trigger types.** Workflows support `schedule` and `webhook` triggers (`server/services/workflow/triggers/TriggerManager.js`, `ScheduleTrigger.js`, `WebhookTrigger.js`).
- **Webhooks need manual setup.** The public endpoint is `POST /api/workflows/:workflowId/webhooks/:triggerId` with HMAC verification (`server/routes/workflow/triggerRoutes.js`). Someone has to configure the external system to call it and to sign the payload. Most SaaS products sign differently or not at all.
- **No polling triggers** and no connector-aware triggers.
- **Scheduled workflow runs run as `{ id: 'system', groups: [] }`,** so they cannot use a user's integration tokens.
- **Scheduled tasks lists event triggers as out of scope.** #2521 names "webhooks, 'when a new email arrives'" as a follow-up. This issue is that follow-up.

## Proposal

### Trigger contract (per connector)

- **Polling:** `poll({ connection, config, cursor }) → { events: [{ id, occurredAt, data }], cursor }`.
  - The connector owns the query: a Graph delta query, a JQL `updated >= cursor` search, the ServiceNow `sys_updated_on` field, and so on.
  - The platform persists the cursor and deduplicates by event `id`.
- **Push, where supported:** `subscribe` / `renew` / `unsubscribe` plus a verified callback.
  - Examples: Microsoft Graph change notifications (subscriptions expire and must be renewed), Jira webhooks, the Slack Events API.
  - Push falls back to polling if the subscription lapses.
- **Filters:** each trigger declares config fields, for example mail folder and sender or subject contains; Jira project and issue type; SharePoint drive and folder. The admin or user sets them when attaching the trigger.

### Targets

- A **workflow**: the start node receives the event `data` as input variables.
- A **scheduled task / app run** (#2521): the event is rendered into the instructions through template variables such as `{{event.subject}}`.

### Initial triggers

| Connector | Trigger | Mechanism |
| --- | --- | --- |
| Outlook Mail | New message in folder (with filters) | Graph delta query or change notifications |
| Outlook Calendar | Event starting in N minutes (meeting prep) | polling of calendarView |
| Jira | Issue created / updated / transitioned in project | JQL polling or Jira webhook |
| OneDrive / SharePoint | File added or changed in folder | Graph delta query |
| Teams | New message in channel | change notifications or polling |
| ServiceNow / Zendesk | Ticket created / updated | polling |

### Execution

- **Runs as the owner of the connection.** Permissions are re-resolved on every run, the same way #2521 re-resolves them for scheduled tasks.
- **One poller per trigger across the cluster:** use `isSchedulerOwner()` today, and `LockManager` leases later (#2313).
- **Limits:**
  - minimum poll interval (admin setting, for example 5 minutes);
  - max events per poll (the rest stay for the next cycle);
  - max concurrent runs per trigger and per user;
  - auto-pause after N consecutive failures, with the reason shown.
- **First activation starts from "now".** It does not replay history, unless the user picks "include items from the last N hours".
- **Event payloads are untrusted content.** A new email can contain instructions aimed at the model. Write actions in trigger-started runs therefore still go through the confirmation gate from #FRAMEWORK: a durable approval the owner answers later, or a per-trigger allow-list the owner grants explicitly.

### UI

- In the workflow editor's start node: a trigger picker that lists the triggers of the user's connected integrations, with filter config and a "test: fetch latest matching item" button.
- A trigger overview listing each trigger with its last poll, last event and last run, a pause/resume toggle and its error state.

## Acceptance criteria

- [ ] Connector trigger contract (polling + optional push) with persisted cursor and event-id deduplication.
- [ ] Triggers for Outlook new mail, Jira issue created/updated, and OneDrive/SharePoint file added/changed (others follow with their connectors).
- [ ] Target a workflow (event as input variables) or an app run / scheduled task (event as template variables).
- [ ] Runs execute as the connection owner; lost access or expired tokens pause the trigger with an actionable reason.
- [ ] Exactly one poller per trigger across cluster workers; min interval, batch caps, concurrency caps, and auto-pause enforced.
- [ ] Write actions in trigger runs require approval or an explicit per-trigger allow-list.
- [ ] Trigger picker in the workflow start node with a test button; trigger overview with status.
- [ ] Tests for cursor handling, deduplication, failure pause and cluster singleton; docs and changelog entry.

## Open questions

1. Should users be able to create triggers for their own scheduled tasks, or only admins for workflows in v1?
2. Push subscriptions need a publicly reachable callback URL. Many on-prem installations don't have one. Polling-only in v1?
3. Should the existing `system`-principal workflow scheduler move to the owner-principal model at the same time?

## Related

- #FRAMEWORK: connections and the confirmation gate.
- #2521: scheduled tasks (targets, headless runs, approvals).
- #2313: multi-instance singletons.
- #1495: background job queue.

---
_Generated by [Claude Code](https://claude.ai/code)_
