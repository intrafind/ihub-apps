# Usage Limits

Usage limits cap how many tokens one user may use, per model and across all models, in daily, weekly and monthly windows. Users see their budgets and when each one resets; administrators see everyone's usage against their limits.

A typical use: offer a new preview model to everyone, with a small budget, without opening the full cost of the model to all users.

## The levels

Limits are set at four levels. Each level can only **lower** the limit of the level above it.

| Level | Where | What it sets |
| --- | --- | --- |
| Model | Admin → Models → *model* → **Usage limits (per user)** (`usageLimits` in the model's JSON) | The most one user may use of this model. The global ceiling. |
| Platform | Admin → Usage Reports → **Limits & quotas** → *Budget across all models* (`platform.json` → `usageLimits.allModels`) | The most one user may use across all models together. |
| Group | Admin → Groups → *group* → **Usage limits** (`usageLimits` in `groups.json`) | Lower limits for the members, per model, across all models, and for file storage. |
| User | Admin → Users → *user* → **Personal usage limits** (`usageLimits` in `users.json`) | Lower limits for one person. |

Who may use a model at all is still decided by the group's `permissions.models`. Limits only apply to models a user can already use.

### How the effective limit is worked out

For every model a user may use and every window:

1. Each of the user's groups gives its own entry. If it has none, it uses its parents' entry (`inherits`). A group with no entry anywhere is **neutral**: it does not limit anything, and it does not lift other groups' limits.
2. Across the groups that do have an entry, the **most generous** one counts. A group with `-1` lifts the limits of the user's other groups. The model's own limit still applies.
3. The effective limit is the lowest of the model limit, that group value, and the user's personal limit.

In a group, an entry for a specific model id beats the `*` entry, which applies to every other model.

Values: a number ≥ 0 is a limit in tokens, and `0` blocks. An empty field (or a missing key) sets no limit at this level. `-1` means unlimited, which is only useful in a group, to lift other groups' limits.

Tokens are counted as prompt plus completion tokens, as reported by the provider. When a provider reports none, they are estimated from the text (about four characters per token).

### Configuration shape

```json
// contents/models/gpt-preview.json
{ "id": "gpt-preview", "usageLimits": { "day": 50000, "month": 500000 } }

// contents/config/groups.json → groups.interns
{
  "usageLimits": {
    "allModels": { "week": 200000 },
    "models": { "gpt-preview": { "day": 10000 }, "*": { "month": 1000000 } },
    "fileStorageBytes": 104857600
  }
}

// contents/config/users.json → users.<id>  (same shape as a group)
{ "usageLimits": { "models": { "gpt-preview": { "day": 2000 } } } }

// contents/config/platform.json
{
  "usageLimits": {
    "allModels": {},
    "resets": {
      "timezone": "Europe/Berlin",
      "dailyAt": "00:00",
      "weeklyOn": "monday",
      "weeklyAt": "00:00",
      "monthlyAt": "00:00"
    }
  }
}
```

## Reset schedule

Every budget resets on a fixed calendar boundary that is the same for everyone. These are not rolling windows.

- **Daily** budgets reset every day at `dailyAt`.
- **Weekly** budgets reset on `weeklyOn` at `weeklyAt`.
- **Monthly** budgets reset on the **1st of the month** at `monthlyAt`.

Times are wall-clock times in `timezone`, an IANA name. When it is empty, the server's time zone is used. A reset at 00:00 stays at 00:00 across daylight-saving changes. Change the schedule under **Usage Reports → Limits & quotas → Reset schedule**, which also shows the next reset times. A new schedule applies at once: the current day, week and month start over, so usage already counted in them starts again from zero.

## Enforcement

Every model call goes through one place, the LLM client. That covers chat, agent steps, workflows, scheduled tasks, magic prompt and the Inference API. Before each call, the caller's budgets for that model and across all models are checked.

- If a budget is used up, the call is refused with code `QUOTA_EXCEEDED`.
  - The chat shows a localized message naming the model, the budget and when it resets.
  - The Inference API answers `429` with `details` holding `{ scope, modelId, window, limit, used, resetAt }`.
- What a call used is counted when the call ends — for every call that names its user, including agent steps and workflow nodes, which show in the reports and are counted the same way — and also when it fails or is stopped after the answer started (by estimate when the provider had not yet reported usage).
- Calls that are already running when a budget runs out still finish, and so do calls that passed the check together, such as parallel agent steps, workflow nodes or API requests. Cluster workers share their counts within a few seconds. A budget can therefore be exceeded by the calls in flight at that moment.
- If the limit check itself fails (for example, an unreadable groups or users configuration), the call is refused rather than let through, with the message "Usage limits could not be checked".
- A multi-step agent run stops at the next model call once the budget is used up.

Calls without a user, such as system work, are neither checked nor counted. A file storage limit of `0` on a group or user turns uploads off for those users. Guests are counted per guest cookie and get the limits of the anonymous groups.

### File storage

`fileStorageBytes` on a group or user lowers the per-user upload limit `uploads.quotas.maxUserBytes` (see [Chat and Task Files](chat-files.md)). Uploads beyond it fail with `QUOTA_USER_BYTES`, as before.

## What users see

- **My usage** (top of the user menu): tokens used today and this month, and the budget closest to its limit with what is left and when it resets. Users see a refusal coming before a call fails with `QUOTA_EXCEEDED`.
- **Usage page** (user menu → **Usage**, `/settings/usage`):
  - Every budget that applies to them, with what they have used, the percentage, when it resets, and where the limit comes from (the model, a group, or a personal limit).
  - This month's usage of models without a limit.
  - Their file storage.
- **Chat:**
  - A notice above the input once the selected model's budget is 80 % used.
  - A red notice once it is used up.
- **Model picker:** each limited model shows how much of its budget is used, or that its limit is reached and when it resets.

Every budget is drawn as a bar that is green, turns amber from 70 % and red from 90 % of its limit, with a countdown to its next reset that stays current while the page is open.

## What administrators see

**Usage Reports → Limits & quotas** (`/admin/usage?tab=limits`) starts with **Near a limit**: every user above 80 % of a budget, one row per budget with its bar and reset countdown, the soonest reset first — who will be refused next, and when that ends. Below it are the settings and three views:

- **Users:**
  - Everyone known to iHub (users in `users.json` and everyone who has used a model), sorted by who is closest to a limit.
  - Search by name, e-mail or group, and filter by users with limits, users near or at a limit, or a single model.
  - **Details** shows every budget with its source, links to the personal limits, and can reset the current counts.
- **Models:** each model's per-user limit, tokens used per window, users this month, and how many are near or at the limit.
- **Groups:** each group's limits, the members seen, and their tokens this month.

The user editor also shows the user's current usage, with a **Reset usage** button.

## API

| Endpoint | Who | Purpose |
| --- | --- | --- |
| `GET /api/usage/me` | signed-in user or guest | own budgets, usage per model and app, file storage, next resets |
| `GET/PUT /api/admin/usage/limits/settings` | admin | platform budget and reset schedule |
| `GET /api/admin/usage/limits/users` | admin | users with their budgets (`search`, `status`, `modelId`, `page`, `pageSize`) |
| `GET /api/admin/usage/limits/users/:userKey` | admin | one user in detail |
| `POST /api/admin/usage/limits/users/:userKey/reset` | admin | reset current counts (`{ modelId?, window? }`) |
| `GET /api/admin/usage/limits/models` | admin | per-model overview |
| `GET /api/admin/usage/limits/groups` | admin | per-group overview |
| `GET /api/admin/usage/limits/near` | admin | users at or above `threshold` (default `0.8`) of a budget, soonest reset first (`threshold`, `limit`) |

## Storage and privacy

Counters live in `contents/data/quota-usage.json`. They are kept per user, model and window, and hold counts only, never content. They are the fast, pre-summed view of the same model calls that the usage analytics ([Usage Reporting](usage-reporting.md)) store: both are written from one call record, in one place, so the tokens of a call are the same in your usage menu, on the Limits & quotas tab and in the reports. The counters are keyed on the real user and written even when analytics tracking is off or pseudonymized, because enforcing a per-user limit needs the real user. Their windows follow the configured reset schedule, whereas the reports use UTC days, so a "today" can differ by the time zone offset. Users not seen for 400 days are removed. Cluster workers add their counts to the file every few seconds under a lock.
