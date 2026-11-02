# iHub 1.0.0

- First version of the always-installed built-in iHub definition. The installation `ihub` is created when missing and can be neither removed nor disabled; admins switch single actions off and limit its groups.
- Eight actions keep their tool ids: `ask_user` and the scheduled-task tools `schedule_task`, `list_scheduled_tasks`, `update_scheduled_task`, `delete_scheduled_task`, `run_scheduled_task_now`, `list_task_runs` and `get_task_run`.
- Apps keep listing them in `tools` by id; `ask_user` survives a chat's tool narrowing and the scheduled-task tools follow the scheduled-tasks gate as before.
- The tools of other iHub features are not actions of this integration: the project knowledge tools come with every request that reaches a project, the agent workspace and evidence tools with the workflows, agents and apps that name them.
