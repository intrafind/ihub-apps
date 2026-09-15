# Release notes

The Markdown in this folder is the in-product changelog (**Admin → What's New**). The server reads
it at runtime (`server/routes/admin/changelog.js`) and every build ships it.

- `next/` — notes for changes that have **not shipped in a tagged release yet**. This is the only
  directory to write to. Use the `/document-feature` skill; it knows the rules.
- `<version>/` — exactly what shipped in that release. The release pipeline creates it from
  `next/` when the release tag is created (`scripts/finalize-release-notes.js`), and it is frozen
  afterwards. A release that shipped nothing worth noting gets no directory.

Each directory holds up to three files — `breaking-changes.md`, `features.md`, `fixes.md` — and
each file is one `#` title followed by `##` entries. `next/` always has all three files; a
published release only has the files that have entries.

`5.4.8` through `5.5.7` were reconstructed from git history in September 2026: their entries had
been written into a single `5.5.0/` folder while those releases were being tagged. Each entry now
sits under the first tag that contained the commit that added it.
