# Breaking Changes — Unreleased

## Apps: IDs of the Form `uap_` Plus 32 Hex Characters Are Reserved

An app ID that consists of `uap_` followed by exactly 32 hexadecimal characters, for example
`uap_3f9c2a0b1d4e5f60718293a4b5c6d7e8`, can no longer be given to an app that administrators
manage. iHub mints IDs of this form for personal apps. This applies whether or not the preview
feature **Personal apps** is switched on.

- **Admin → Apps**, `POST` and `PUT /api/admin/apps`, a Marketplace install and the example apps
  of an integration refuse such an ID with a validation error:

  > This ID is reserved for personal apps

- An ID that only starts with `uap_`, such as `uap_helper`, is still accepted.
- An existing app file with such an ID keeps loading and working. The server log shows a
  validation warning for it, and it can no longer be saved in the admin UI under that ID.

**Before upgrading:** Check `contents/apps/` for an app whose `id` has this form, for example
with `grep -lE '"id": *"uap_[a-f0-9]{32}"' contents/apps/*.json`. Give such an app another ID:
rename the file and its `id`, and replace the old ID in the `apps` lists of `groups.json`. Chats
and usage records keep the old ID. Installations without such an app need no action.
