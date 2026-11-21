# Breaking Changes — Unreleased

## Only the Chat Owner Can Send a Message to a Running Answer or Answer Its Approvals

A message into a running answer, the answer to an approval or to a question, and a rating are
now the owner's alone. Until now every admin could do all of this in another user's run, and
anyone who held the id of an anonymous visitor's run could do it there. An approved call runs
with the owner's rights, so nobody else gives the approval.

- **Admins** still read every run and can stop or delete it; a stop or a delete of somebody
  else's run is now written to the audit log (Admin → Audit Log, resource `run`). An admin can no
  longer answer an approval or a question of another user's run, rate its answers or send a
  message into it. Unchanged: approvals that name an approver group (the group's members and
  admins answer them), and the approvals and questions of agent runs and of workflow runs a
  trigger started, which run under an identity of their own and are answered by admins as before.
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
