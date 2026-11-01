# iHub 1.0.0 — breaking changes

Config migrations V199 and V201 moved the tools into the installation:

- The shipped tool files `ask_user.json`, `schedule_task.json`, `list_scheduled_tasks.json`, `update_scheduled_task.json`, `delete_scheduled_task.json`, `run_scheduled_task_now.json`, `list_task_runs.json` and `get_task_run.json` are removed from `contents/tools/`; a file that was `enabled: false` becomes an entry of the installation's `actions.disabled`. A file an admin edited is kept, with a warning, and keeps serving its tool until it is deleted.
- The knowledge, agent workspace and evidence tools are not actions of this installation: V201 removes them from its `actions` lists. A knowledge tool switched off there no longer applies — the knowledge tools come with every request that reaches a project. An agent workspace or evidence tool switched off there stays off through its tool file in `contents/tools/` (`enabled: false`).
