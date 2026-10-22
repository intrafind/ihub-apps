# Sources System

Sources have become **projects**. Everything an admin configured in `config/sources.json` is now an
admin project under `contents/projects/`, linked to apps, workflows and agents through their
`projects` lists, and the models reach it through the knowledge tools instead of one tool per
source.

- How projects work, their item kinds, modes, settings and API: [Projects](projects.md).
- What the migration moved where, and what changed for custom configuration: the release note
  *Sources are now Projects* in [What's New](releases/README.md) (`docs/releases/`).
- The documentation the iHub Support Bot answers from is an admin project too; see
  [Projects](projects.md#admin-projects).
