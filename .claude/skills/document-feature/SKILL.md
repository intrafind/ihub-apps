---
name: document-feature
description: Use when a new feature, improvement, bug fix, or breaking change has been implemented. Adds an entry to docs/releases/ so it appears in the in-product admin changelog.
user-invocable: true
---

# Release Documentation

When a feature, improvement, bug fix, or breaking change is implemented, add an entry to the
appropriate Markdown file under `docs/releases/`.

## Determining the Version

Read the current version from `server/package.json` → `version` field.
If the version contains a build suffix (e.g. `fix-issue-1137-lVuXg`) look for the nearest clean
semver tag in the git log: `git tag --sort=-version:refname | head -5`.
Use the highest existing `docs/releases/` subdirectory name as a fallback.

## Directory Structure

```
docs/releases/{version}/
  features.md         New capabilities (admin-facing and end-user-facing)
  fixes.md            Corrections to behaviour that was already supposed to work
  breaking-changes.md Changes that require admin action after upgrade
```

If the version directory does not exist yet, create it and all three files with an empty heading:

```markdown
# Features — {version}
```

```markdown
# Fixes — {version}
```

```markdown
# Breaking Changes — {version}
```

## Choosing the File

Pick by what the reader gets, not by how the work was labelled or which branch it came from:

| The change…                                                              | File                  |
| ------------------------------------------------------------------------ | --------------------- |
| lets someone do something they could not do before                        | `features.md`         |
| makes something existing faster, clearer, or easier — nothing was broken  | `features.md`         |
| makes something work that was supposed to work already                   | `fixes.md`            |
| closes a security hole in shipped behaviour                              | `fixes.md`            |
| requires an admin to act during or after the upgrade                     | `breaking-changes.md` |

Two rules settle most of the hard cases:

- **One entry, one file.** A change that both fixes a bug and adds a capability goes wherever its
  headline belongs — do not write it twice. A breaking change is always documented as a breaking
  change, even when it is also a fix.
- **Titles say what is true now, not what was wrong.** Both files use the same voice, so
  "Chat exports no longer lose attachments" belongs in `fixes.md` on the strength of what it does,
  not because the title contains "no longer".

When it is genuinely ambiguous, ask: would an admin reading this be *relieved* (fix) or *interested*
(feature)? Relief goes in `fixes.md`.

## Entry Format

Each entry is a `##` level heading. Keep it product-oriented — what changed and what it enables,
not implementation details.

```markdown
## Short Title

One or two sentences describing what this does and why it matters to admins or users.

- Key detail 1
- Key detail 2

**Before upgrading:** Migration step if any (breaking changes only).
```

Include a configuration or API example only when admins need to take action.

## Writing Style

- **Audience:** admins and operators who read the in-product changelog. Not developers.
- **Tense:** present tense ("Admins can now…", "The sidebar now…").
- **Concise:** one paragraph plus bullets maximum. No filler phrases.
- **Scope:** omit internal refactors, dependency bumps, and test changes unless they have
  a visible effect.
- **Fixes name the symptom.** An admin recognises the bug by what they saw, not by the cause, so
  lead with the symptom and only then the reason: "The admin start page showed only grey
  placeholders on installations without internet access — the update check had no timeout."

## Workflow

1. Identify the version (see above).
2. Decide which file the entry belongs in (see **Choosing the File**).
3. Read the existing entries in that file for that version to avoid duplication.
4. Read the code changes to understand the user-visible impact.
5. Append the new `##` entry to that one file.
6. For breaking changes: always include a **Before upgrading:** migration note.

## When to Use

Use this skill proactively whenever you implement:

- A new admin page, section, or feature → `features.md`
- A change to configuration schema (new fields, renamed fields, removed fields) →
  `features.md`, or `breaking-changes.md` when existing installs need action
- A change to API behavior that operators rely on → `features.md` or `breaking-changes.md`
- A bug fix or security fix that users/admins would want to know about → `fixes.md`
- Anything that appears in the admin "Needs your attention" feed

Skip for: pure refactors with no visible behavior change, dependency bumps, test additions,
comment/documentation-only changes.

## Plumbing

The in-product changelog reads these files directly, so a new file name is not picked up on its own.
`server/routes/admin/changelog.js` chooses which files to read and
`client/src/features/admin/pages/AdminChangelogPage.jsx` renders each section — both must know
about any file added here.
