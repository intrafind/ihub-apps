# Breaking Changes — Unreleased

## Anonymous Access: Group Permissions Apply to Every Request

Requests without a sign-in are now checked against the permissions of the groups in
`anonymousAuth.defaultGroups` on every endpoint, including the OpenAI-compatible inference API
(`/api/inference/v1`), app and model details, the model test and Magic Prompt. Visitors who are
not signed in can only use the apps and models those groups grant.

- `GET /api/apps/{appId}` and `GET /api/models/{modelId}` answer `404` for an app or model the
  caller may not use, signed in or not — the same answer as for one that does not exist.
- Magic Prompt takes its instruction and model from the app's `features.magicPrompt` settings. A
  `prompt` sent with the request is ignored, and a requested model must be one the caller may use.
- Magic Prompt requests count against the general API rate limit.
- Anonymous users never have admin or content-admin access, even when one of their default groups
  grants it.

**Before upgrading:** if visitors who are not signed in use the inference API or Magic Prompt,
check that the anonymous group in `groups.json` grants the apps and models they need. Scripts that
send their own `prompt` to `/api/magic-prompt` need an app with that instruction configured
instead.
