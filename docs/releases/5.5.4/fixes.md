# Fixes — 5.5.4

## Saving a Group No Longer Wipes Its Skills and Tools Permissions

Opening a group in **Admin → Groups** and saving it silently dropped that group's `skills`
permission — and, on installations already using it, the new `tools` permission and the
`contentAdmin` flag. Nothing in the UI indicated the loss; the group simply stopped granting agent
skills, and users in it lost access to every skill until the permission was restored by hand.

The cause was the create and update endpoints, which rebuilt the permission object from a fixed list
of fields covering apps, prompts, models and workflows but nothing added since. Both now go through
a single place that covers every permission, so a group keeps what it was granted.

If a group has already lost its permissions this way, re-add them in **Admin → Groups** once on the
upgraded version and they will persist.

## The Admin "What's New" Changelog Is No Longer Empty

The changelog page under **Admin → What's New** showed "No changelog entries yet." on every
packaged deployment — the Docker image, a `dist/` production build, and the standalone binary.
The release notes it reads live in `docs/releases/`, but that folder was never included in what
those builds actually ship, so the page had nothing to display even though real entries existed.
It now shows the same release history in every deployment as in local development.
