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
  admins answer them), and the approvals and questions of agent runs and of workflow runs a
  trigger started, which run under an identity of their own and are answered by admins as before.
- **Admin → Agents → Pending Approvals & Questions** still lists every pending approval and
  question. An entry of a run a user started that names no approver group can now only be read
  there: the user who started the run answers it, and an admin who tries gets
  `403 FORBIDDEN`. The page says so above the list; it does not mark the single entries yet.
- **Not changed, and not audited:** cancelling, restarting or deleting a workflow run from the
  workflow run pages (`/api/workflows/executions/...`) and cancelling or resuming an agent run
  from the agent run pages (`/api/agents/runs/...`). These routes keep their own check: an admin
  can still do this to another user's run, and no audit entry is written.
- **Anonymous visitors**: a run started without sign-in is stopped, deleted, rated and answered
  only from the browser session that started its chat (the guest cookie). The run id alone
  still reads the run and nothing more.
- **Agent runs** take no message while they run: they run under the agent's own identity, and
  only an owner sends one. The person who triggered the run reads, stops and answers it as before.
- **API**: `POST /api/runs/{runId}/human-events` with `kind: "steer"` answers
  `403 RUN_STEER_FORBIDDEN` to anyone but the owner, `409 RUN_NOT_ACTIVE` while the run waits for
  an approval (the approval stays pending), and `429 RATE_LIMITED` after 30 messages of one caller
  in a minute. `POST /api/runs/{runId}/interactions/{id}/answer` answers `403 FORBIDDEN` to an
  admin who is not the owner. There is no setting that restores the old behaviour.

**Before upgrading:** If admins or a script answer approvals or questions of other users' runs
through the API (a workflow a user started, a scheduled task of a user), have the owner answer
them. A script that stops an anonymous visitor's run with the run id alone needs an admin
sign-in now.

## Prompt Library: the App Generator Prompt Is Removed

The prompt **App Generator** (`app-generator`) is no longer part of the prompt library. It
prepared app drafts for the old **Generate with AI** wizard. The app builder of **New app** drafts
apps with iHub's own instructions, so the prompt steered nothing any more, yet every user saw it
on `/prompts`.

- An update deletes `contents/prompts/app-generator.json`, also a copy an administrator changed.
  A prompt with the ID `app-generator` stored under another file name is left alone.
- The endpoint `GET /api/admin/prompts/app-generator` is removed. Once the prompt is gone, the
  path answers 404 like any unknown prompt ID.
- New installations no longer ship the prompt.
- The answer of `POST /api/admin/apps/_generate` and `POST /api/apps/_generate` no longer has
  the field `brief`, which said whether a changed prompt prepared the draft.

**Before upgrading:** If you changed the App Generator prompt and want to keep its text, copy
`contents/prompts/app-generator.json` out of `contents/` first. Scripts that call
`GET /api/admin/prompts/app-generator` must stop doing so; there is no replacement.

## Access: Anonymous Visitors Use Only the Default Model

The group **Anonymous** now grants the Chat app and **the default model**: whichever model is
marked as the default on the Models page. Before, it named its models (`gemini-flash-latest` and
`local-vllm`). Every signed-in user inherits **Anonymous**, so those models were granted to
everyone and could not be limited to a smaller group, such as HR.

- A group's model list can hold the new entry **Default model (whichever is set as default)**,
  `"@default"` in `groups.json`. It grants the model that is the default at that moment and moves
  with it when you make another model the default. **All (\*)** still grants every model.
- An update changes the **Anonymous** model list to `["@default"]` only if it is still a shipped
  list: `gemini-flash-latest` and `local-vllm`, or `gemini-flash-latest` alone. A list you changed
  stays as it is; the server log says that it was left alone.
- After the update, anonymous visitors on such an installation can use only the default model.
  Signed-in users keep their models through their other groups (**All (\*)** on a new
  installation).
- **Who can use this model** and **Why can't someone see this?** show a grant through this entry
  as "as the default model". **Restrict access** leaves the entry alone and says when the model
  stays usable through it.

**Before upgrading:** If anonymous visitors should keep a model that is not the default, add it to
the group **Anonymous** under **Access & Identity → Groups → Permissions → Models** after the
update.
