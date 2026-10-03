# Skills

A skill packages know-how for a task: instructions the model follows and, optionally, reference
files it can read. iHub uses the Agent Skills format (agentskills.io), the same `SKILL.md` format
Claude, ChatGPT and Gemini read. Skills need the **Agent Skills** feature (`skills`, preview,
off by default) under **Admin → Features**.

There are two kinds:

| Kind | Where it lives | Created by | Who can use it |
| ---- | -------------- | ---------- | -------------- |
| **Global skill** | A folder under `contents/skills/<name>/` | Admins (import, marketplace, promotion) | Users whose groups grant it (`permissions.skills`), in the apps it is assigned to (`skills` in the app) |
| **User skill** | The storage provider | Any signed-in user | The owner and everyone it is shared with, in every app that allows personal skills |

## Using Skills in Chat

- **Automatically:** the model sees the name and description of every skill it may use in the
  current app and loads a skill's full instructions when a request matches.
- **With `/`:** typing `/` in an empty chat input lists the skills next to the prompts. Picking a
  skill loads its instructions for that message. The chat API receives the pick as
  `requestedSkills`, a list of global skill names or user skill ids; at most
  `skillSettings.maxActiveSkills` (default 3) are loaded per message.

A skill is loaded only when the current app and user may use it. For a global skill that means:
installed, listed in the app's `skills`, and granted to the user's groups. For a user skill: the
user owns it or it is shared with them, and the app does not set
`skillSettings.allowPersonal: false`. Agents use only the global skills on their profile.

## User Skills

Any signed-in user can create skills of their own on `/skills` (**New skill**). The editor has:

- **Name** — lowercase letters, digits and hyphens, starting and ending with a letter or digit,
  at most 64 characters.
- **Description** — what the skill does and when to use it, at most 1,024 characters. This is
  what the model reads to decide when to use the skill, so name the requests that should trigger
  it ("Use when …").
- **Instructions** — the Markdown the model follows once the skill is loaded.
- **Files** — optional text files under `references/`, `assets/` or `scripts/` (`.md`, `.txt`,
  `.csv`, `.json`, `.yaml`). The model reads them when the instructions point to them. Scripts
  are never run.

The marketplace skill **Skill Builder** interviews a user about a task and writes a skill they
can paste into the editor.

### Sharing and permissions

User skills follow the same rules as [user prompts](prompts.md#user-prompts):

- A skill is private until it is shared with **specific users**, **groups** (inheritance
  resolved) or **everyone signed in**, each as *can use* or *can edit*. Editors can share it
  further.
- Only the owner and admins can delete a skill or hand it to another user.
- Removing a share takes effect right away, in the skill list, the `/` picker and the model's
  list of skills.
- When the owner's account is deleted or deactivated, the skill stays usable for everyone it is
  shared with but becomes read-only; only admins can still change it.
- Anonymous users, API clients (client credentials, static API keys), agents and third-party
  apps acting on a user's behalf cannot hold user skills. A personal API key acts as its owner.
- Anyone who can see a skill can **duplicate** it, and a global skill can be copied into
  **My skills** to adapt it. The copy takes the instructions and the text files.

### Versions

Every save is kept as a version. Those who can edit a skill can open **History**, look at an
earlier version and restore it; a restore is saved as a new version.

### Using user skills in an app

A user's own and shared skills are offered in every app, in the `/` picker and to the model (the
20 most recently changed ones). To keep them out of an app — for example a regulated app that
must only use reviewed skills — set:

```json
"skillSettings": { "allowPersonal": false }
```

## Admin

**Admin → Skills** manages the global skills (import, export, delete, group access) and has a
**User skills** tab:

- It lists the user skills shared with a group or with everyone. Private skills and skills
  shared only with named users are not listed.
- Admins and content admins can open, edit, re-share, view the history of and delete these
  skills, and **promote** one. Promoting writes the skill as a global skill folder
  `contents/skills/<name>/` (`SKILL.md` with the description, the instructions and the files)
  and records where it was promoted to. Who can use the new global skill follows the groups'
  `skills` permission and the apps it is assigned to, like every other global skill.
- Every create, update, share change, hand-over, delete, restore and promotion is written to the
  audit log.

### Settings

The settings for user skills (full admins only) are stored in `platform.json`:

```json
"userSkills": {
  "enabled": true,
  "maxSkillsPerUser": 50,
  "maxVersions": 50,
  "maxSkillSizeKB": 256,
  "maxFilesPerSkill": 20,
  "sharing": {
    "allowUsers": true,
    "allowGroups": true,
    "allowEveryone": true,
    "restrictToGroups": []
  }
}
```

| Setting | Meaning |
| ------- | ------- |
| `enabled` | Users may keep their own skills (also needs the `skills` feature) |
| `maxSkillsPerUser` | Most skills one user may keep; `0` means no limit |
| `maxVersions` | Versions kept per skill |
| `maxSkillSizeKB` | Instructions and files together |
| `maxFilesPerSkill` | Files per skill |
| `sharing.allowUsers` / `allowGroups` / `allowEveryone` | Which audiences users may share with |
| `sharing.restrictToGroups` | When it names groups, only their members may share with groups or with everyone |

### Storage

User skills, their versions and share markers are runtime data in the storage provider
(`contents/data/` with the default filesystem provider), in the namespaces `user-skills`,
`user-skill-versions` and `user-skill-shares`. A skill's instructions and files are kept
together in one document. If the storage provider is unavailable, users cannot create skills;
global skills keep working.

## API

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/api/skills` | Skills for the `/` picker: global skills the user may see, plus their own and shared user skills (`scope`: `global`, `mine`, `shared`) |
| POST | `/api/skills/:name/duplicate` | Copy a global skill into My skills |
| GET | `/api/user-skills?scope=all\|mine\|shared` | The caller's own and shared user skills |
| POST | `/api/user-skills` | Create a user skill (`name`, `description`, `body`, `files`) |
| GET / PUT / DELETE | `/api/user-skills/:id` | Read (with instructions and files), update (`expectedRevision` refuses a stale save with 409), delete |
| PUT | `/api/user-skills/:id/shares` | Replace the share list |
| PUT | `/api/user-skills/:id/owner` | Hand the skill to another user (`ownerId`) |
| POST | `/api/user-skills/:id/duplicate` | Copy a user skill |
| GET | `/api/user-skills/:id/versions` | Versions, newest first; `/versions/:revision` returns one with its content |
| POST | `/api/user-skills/:id/versions/:revision/restore` | Restore a version |
| GET | `/api/user-skills/share-targets?q=` | Users and groups the caller may share with |
| GET | `/api/admin/user-skills` | User skills shared with a group or everyone (admins and content admins) |
| POST | `/api/admin/user-skills/:id/promote` | Promote to a global skill (`name` optional; 409 when taken) |
| GET / PUT | `/api/admin/user-skills/settings` | The `userSkills` settings (full admins) |
