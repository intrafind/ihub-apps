# Breaking Changes — Unreleased

## An Unknown `projects.encryption.keyProvider` Stops the Start

The server no longer starts when `projects.encryption.keyProvider` in
`contents/config/platform.json` names a key provider it does not know. Until now such a value was
replaced by `local-file` without a message, so a typing mistake or a provider of a later release
went unnoticed and the documents were encrypted with another key than the configuration said.

- `local-file` is the only key provider in this release. It is also the default: an installation
  that does not set the value is not affected.
- The start ends with an error that names the value and the providers that exist:

  > Unknown key provider 'vault'. Registered: local-file

**Before upgrading:** Open `contents/config/platform.json` and look for `projects.encryption`. If
`keyProvider` is set to anything other than `local-file`, set it to `local-file` or remove the
line. No data changes: the server has used `local-file` for these installations all along.
