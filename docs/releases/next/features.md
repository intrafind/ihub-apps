# Features — Unreleased

## Scheduled Tasks (Preview)

Users can now save a prompt as a task that runs by itself, as them, in one of their apps: every
weekday at 08:00, once next Tuesday, every two hours, on the last day of the month, or only when
they press **Run now**. Every run becomes its own chat, marked unread until they open it, so
morning digests and weekly reports are waiting when they come in.

- Turn it on under **Admin → Features → Scheduled Tasks** (requires **Durable Chats**). Users then
  find **Scheduled tasks** in the sidebar.
- Schedules: once, interval, daily, weekdays, weekly, monthly (the 29th–31st fall back to the last
  day of shorter months) and cron, in the user's time zone across daylight saving time, with an
  optional start, end and number of runs.
- Runs use the app's tools, integrations, sources and workflows with the owner's current
  permissions. An owner who loses access to the app, model or a tool gets a skipped run and a
  paused task with the reason; an expired integration sign-in shows a **Reconnect** link.
- The task page lists every run with status, duration, reason and a link to its chat. A missed
  slot after a restart runs once as a catch-up, never many times; runs of one task never overlap.
- Tools marked `"requiresApproval": true` pause a run until the owner approves or rejects it, with
  an **Always allow for this task** option that can be revoked later.
- Apps can offer scheduling tools (`schedule_task`, `list_scheduled_tasks`,
  `update_scheduled_task`, `delete_scheduled_task`, `run_scheduled_task_now`) by listing them in
  their tools. The assistant only proposes a task; the user saves it on a confirmation card.
- **Admin → Scheduled Tasks** shows every user's tasks, lets admins pause, disable or delete them,
  and sets the limits: tasks per user, minimum interval (15 minutes), concurrent runs, catch-up
  window, approval timeout and more.
- A new **Scheduled tasks** group permission decides who may create tasks. The upgrade grants it to
  `admins`, `users` and `authenticated` and denies it to `anonymous`. Custom groups keep what they
  have.
- Run chats do not count toward the per-user chat limit; each task keeps its 20 most recent.

## Workflows: Schedule Triggers Apply Without a Restart

Adding, changing or removing a workflow's schedule trigger now takes effect as soon as the
workflow is saved. Before, schedules were read once at server start and edits needed a restart.
Schedule triggers now run on the same scheduler as scheduled tasks.
