# Release notes per tag and the What's New redesign

**Issue:** [#2367 Improve What's new](https://github.com/intrafind/ihub-apps/issues/2367)
**Date:** 2026-09-15

## Problem

- `docs/releases/5.5.0/` grew to 168 entries and 2,900 lines while releases v5.4.8 … v5.5.7 were
  being tagged from `main`. The page called all of it "Version 5.5.0"; an admin on 5.4.20 saw
  features from 5.5.7 listed as theirs, and nobody could tell what a given upgrade brought.
- The page rendered the three files as one scroll with a hand-rolled Markdown subset: no nested
  lists, numbered lists, block quotes, tables, links or italics, and every hard-wrapped line
  became its own paragraph.
- Breaking changes came last, after ~1,800 lines of features.
- The `document-feature` skill guessed the version from `package.json` (stuck at 5.4.13 because
  the release commit-back never landed on `main`), always appended, and never asked whether an
  entry was warranted. Result: three entries for one badge fix, and fixes for features that had
  never shipped.

## Decisions

### `next/` until there is a tag

Release notes are written to `docs/releases/next/`. The tag decides the number:
`scripts/finalize-release-notes.js` moves `next/` to `docs/releases/<version>/` when a release is
created — only when `next/` has entries, only the files with entries — and leaves the three
heading-only files behind. Numbered directories are frozen.

The script has two modes because the branch can move between tag and commit-back:

- **working tree** (build jobs, tagged checkout): rename in place, nothing committed; the artifact
  ships the right directory.
- **`--from-ref <tag> --commit`** (commit-back job, default branch): the released entries are read
  from the tag's commit; `next/` on the branch is reduced by those entries, matched by title, so
  anything merged after the tag stays unreleased.

Alternatives considered:

- *Attribute entries to tags at build time from git history, never rename in the repo.* Exact, no
  commit-back needed, but `next/` would grow forever, the repo would not show per-release notes,
  and Docker builds have no `.git`. Rejected.
- *Open a PR instead of pushing to the default branch.* Safer under branch protection, but
  someone has to merge it for every release. The existing job already intended a direct push; we
  fixed the push instead and made the release assets independent of it.

### The commit-back job was broken

`commit-version` checked out the tag (the release event's ref) and ran
`git push origin HEAD:${{ github.ref_name }}` — the tag name — with the failure swallowed by
`|| echo`. No version bump ever reached `main`. It now checks out the default branch, pushes to
it by name with a rebase-and-retry loop, and fails visibly. The `release` job uses
`if: always() && needs.build.result == 'success'` so binaries are attached even if the commit-back
fails or is skipped (`workflow_dispatch`).

### Structured endpoint, one release at a time

`GET /api/admin/changelog` returns the releases (newest first, `next` ahead as `unreleased`) with
entry counts and the running version; `GET /api/admin/changelog/:version` returns one release's
entries per section with bodies as Markdown. Parsing lives in `server/utils/releaseNotes.js`
(fence-aware `##` splitting, slug ids, semver ordering with prereleases) and is shared with the
release script. Directories without entries are not listed; names that are not `next` or semver
never reach the filesystem. The previous response shape (three raw Markdown strings per version,
five versions) is gone; the page was its only consumer.

### Page

Version switcher (sticky on wide screens, a chip row on phones) → release header with
**Installed** / **New** badges and counts → table of contents → breaking changes (amber, first)
→ new & improved → fixes. Bodies render through the shared `marked` config with
`breaks: false` (the files are hard-wrapped) and headings inside an entry demoted one level below
the entry's `<h3>`. Titles render inline (they carry inline code). The `renderInlineMarkdown`
helper and the `breaks` option were added to `marked.config.js` for this.

### Skill

`document-feature` now: always `next/`; a "should this be documented at all?" gate (invisible →
no; the affected behaviour never shipped → edit the feature's entry or write nothing; already
covered → extend, don't duplicate); append at the end; titles unique; wrap at 100 columns.

## Migration of the existing notes

Every `##` entry in `docs/releases/5.5.0/` was attributed to the first tag (semver order)
containing the oldest commit that added its heading line (`git log --reverse -S'## <title>' --
<file>`, then `git tag --contains --sort=version:refname`). All 168 entries resolved; they now sit
in 24 directories, `5.4.8` … `5.5.7` (`5.4.21` shipped nothing note-worthy). `5.4.0/` was left as
is: its file was restructured wholesale after the tag, so attribution would be noise.

## Follow-ups

- Copy the published notes into the GitHub release body from the commit-back job.
- If `main` gets a ruleset that blocks the direct push, switch the job to opening a PR.
