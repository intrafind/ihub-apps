# Fixes — 5.5.5

## Config Editors No Longer Reject Configuration They Just Opened

Opening a group in **Admin → Groups** reported "enabled is required" and "must NOT have additional
properties" before anything was edited. The same false errors hit every other config editor: in
**Admin → Apps** they also disabled the Save button, so an app could not be edited at all — opening
any shipped app reported missing `type`, `sendChatHistory` and `disallowModelSelection`, none of
which an app has to set.

The editors validate against a schema generated from the server's own validation rules. That
generator described the result of validation rather than what an admin may type, so it demanded
every field that has a default — `enabled` and `tools` on a group, `type` and `modelType` on apps
and models, and all 21 sections of the platform config — and rejected any field it did not list.
It now describes the accepted input, so fields with defaults stay optional.

The group editor also recognises the `contentAdmin` permission, which it previously reported as an
unknown property on any group holding it, including the `content-admins` group iHub creates itself.

No configuration was lost: the errors were raised when a config was read, never while writing one.
