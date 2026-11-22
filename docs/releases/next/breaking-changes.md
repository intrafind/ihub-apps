# Breaking Changes — Unreleased

## Only the Chat Owner Can Send a Message to a Running Answer or Answer Its Approvals

A message into a running answer, the answer to an approval or to a question, and a rating are
now the owner's alone. Until now every admin could do all of this in another user's run, and
anyone who held the id of an anonymous visitor's run could do it there. An approved call runs
with the owner's rights, so nobody else gives the approval.

- **Admins** still read every run and can stop or delete it; a stop or a delete of somebody
  else's run through `/api/runs` is now written to the audit log (Admin → Audit Log, resource
  `run`), and the entry of a stop says whether anything was still running. An admin can no
  longer answer an approval or a question of another user's run, rate its answers or send a
  message into it. Unchanged: approvals that name an approver group (the group's members and
  admins answer them), and the approvals and questions of workflow runs a trigger started, which
  run under an identity of their own and are answered by admins as before.
- **`GET /api/interactions/pending`** still lists every pending approval and question to an
  admin. An entry of a run a user started that names no approver group can now only be read
  there: the user who started the run answers it, and an admin who tries gets
  `403 FORBIDDEN`. The list does not mark the single entries yet.
- **Not changed, and not audited:** cancelling, restarting or deleting a workflow run from the
  workflow run pages (`/api/workflows/executions/...`). These routes keep their own check: an
  admin can still do this to another user's run, and no audit entry is written.
- **Anonymous visitors**: a run started without sign-in is stopped, deleted, rated and answered
  only from the browser session that started its chat (the guest cookie). The run id alone
  still reads the run and nothing more.
- **API**: `POST /api/runs/{runId}/human-events` with `kind: "steer"` answers
  `403 RUN_STEER_FORBIDDEN` to anyone but the owner, `409 RUN_NOT_ACTIVE` while the run waits for
  an approval (the approval stays pending), and `429 RATE_LIMITED` after 30 messages of one caller
  in a minute. `POST /api/runs/{runId}/interactions/{id}/answer` answers `403 FORBIDDEN` to an
  admin who is not the owner. There is no setting that restores the old behaviour.

**Before upgrading:** If admins or a script answer approvals or questions of other users' runs
through the API (a workflow a user started, a scheduled task of a user), have the owner answer
them. A script that stops an anonymous visitor's run with the run id alone needs an admin
sign-in now.

## The Agent Factory Is Removed

The Agent Factory, a preview feature, is gone: its admin pages, its API and its switch. Nothing
replaces it in this release. Workflows keep running, also those with memory, inbox or planner
steps such as the shipped law consultation workflows.

- **Admin pages:** everything under **Admin → Agents** (profiles, memory, inboxes, runs, and
  **Pending Approvals & Questions**) shows the not-found page. The sidebar entry is gone.
- **No list of pending workflow approvals:** **Pending Approvals & Questions** also listed the
  open steps of workflow runs: **Ask a Person** steps, tool approvals routed to approver groups,
  and the steps of runs a trigger started. No page lists them across runs any more. They are
  answered on the run's page (**Workflows → Executions**) or in its chat; an admin reads the
  whole list through `GET /api/interactions/pending`.
- **API:** `/api/agents/{runs,profiles}` (start, list, read, stream, artifacts, cancel and resume
  of agent runs) and `/api/admin/agents/{profiles,inboxes,memory/shaper-prompt}` (profiles, their
  memory, inboxes) answer `404` with an `application/problem+json` body and the code
  `NOT_FOUND`, as every API path no route serves now does (it used to be an HTML page).
- **Switch:** **Agent Factory** is no longer in **Admin → Features**; a value left in
  `features.json` does nothing.
- **Shipped profiles:** `claude-style-agent` and `claude-style-agent-phased` are no longer
  installed on a new installation.
- **Runs not finished at the upgrade** (running, waiting to start, or paused at an approval or a
  question) are cancelled when the server starts, with the reason `AGENT_FACTORY_REMOVED`, and are
  not resumed. Their open approvals and questions are withdrawn. Finished runs stay as they are.
  **Restart** on such a run's page, also on one that had failed, answers `409 CONFLICT`. Workflow
  runs that only wrote artifacts are no Agent Factory runs and are resumed as before.
- **Stored files stay on disk** and are neither moved nor deleted: agent profiles
  (`contents/agents/profiles/`), memory files (`contents/agents/memory/*.md`), inboxes
  (`contents/data/agent-inboxes/`), artifacts (`contents/data/agent-artifacts/`) and the agent runs
  in the `workflow-state` namespace (`contents/data/workflow-state/`).
- **App tools in workflows:** a prompt step with a list of `apps` offered them as tools only inside
  an Agent Factory run, so no workflow run offers them any more.

**Before upgrading:** Let running Agent Factory runs finish, or accept that they are cancelled.
Copy what you still need from the runs' artifacts and the memory files; afterwards no page shows
them. A workflow that reads a profile's memory file (the iFinder corpus map of
`stellungnahmen-review-ifinder`) keeps reading it; edit that file on disk from now on. The help
text of that workflow's **agentProfileId** start field still names the removed endpoint
`POST /api/admin/agents/profiles/<id>/memory/from-tool`; ignore it. See
[Agent Factory (Removed)](../../agents.md).
