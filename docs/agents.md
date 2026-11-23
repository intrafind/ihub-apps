---
description: "The Agent Factory, its admin pages and its API were removed. What happens to its stored files and its runs."
audience: admin
type: reference
---

# Agent Factory (Removed)

The Agent Factory was a preview feature: agent profiles with their own workflow,
memory file, inbox and approver groups, started from **Admin → Agents** or through
`/api/agents`. It is removed. Nothing replaces it in this release.

## What is gone

- The admin pages under **Admin → Agents**: the profile list and editor, the memory
  editor, the inboxes, the run list and run page, and **Pending Approvals &
  Questions**. A link to one of them shows the not-found page.
- The API: `/api/agents/...` (start a run, list runs, read a run, its stream and its
  artifacts, cancel, resume) and `/api/admin/agents/...` (profiles, memory, inboxes).
  These paths answer `404` with an `application/problem+json` body and the code
  `NOT_FOUND`.
- The **Agent Factory** switch in **Admin → Features**. A value for it that is still
  in `contents/config/features.json` does nothing.
- The two shipped profiles `claude-style-agent` and `claude-style-agent-phased`. A new
  installation gets no agent profile.

## Runs that were not finished

When the server starts, it cancels every Agent Factory run that is not finished:
running, waiting to start, or paused at an approval or a question. The run is
stored as cancelled with the reason `AGENT_FACTORY_REMOVED`, its open approvals
and questions are withdrawn, and it is not resumed. Finished runs stay as they
are.

Such a run is not started again either: **Restart** on its page (`POST
/api/workflows/executions/<id>/_restart`) answers `409 CONFLICT`, also for an Agent
Factory run that had failed. An approval or a question that such a run still holds
(when the cancel at the start failed) is refused with `AGENT_FACTORY_REMOVED`: the
run does not continue as the agent's identity. A workflow run that only wrote
artifacts (its data holds `_agent.artifacts`, but no profile) is no Agent Factory
run and is resumed as before.

## Stored files

Nothing is moved or deleted. These files stay on disk until you remove them:

| What           | Where                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| Agent profiles | `contents/agents/profiles/<id>.json`                                                                    |
| Memory files   | `contents/agents/memory/<profileId>.md`                                                                 |
| Inboxes        | `contents/data/agent-inboxes/<id>.md`                                                                   |
| Artifacts      | `contents/data/agent-artifacts/<executionId>/`                                                          |
| Runs           | the `workflow-state` namespace (filesystem provider: `contents/data/workflow-state/<executionId>.json`) |

A profile that still links an admin project keeps that link: the project lists
the profile as a dependency, without a link to an admin page. To remove the
link, edit or delete the profile's file.

## Workflows

Workflows keep running, also those with memory, inbox or planner steps, such as
the shipped law consultation workflows. One thing changes: a prompt step with a
list of `apps` offered those apps as tools only inside an Agent Factory run. In
a workflow run it never did, and now no run does.
