---
name: document-feature
description: Use when a new feature, improvement, bug fix, or breaking change has been implemented. Adds an entry to docs/releases/next/ so it appears in the in-product admin changelog ("What's New") — or decides, with reasons, that nothing needs one.
user-invocable: true
---

# Release Documentation

Admins read `docs/releases/` as **Admin → What's New**. Every change that admins or end users can
see gets an entry there — in `docs/releases/next/`, and nowhere else.

## Where Entries Go

Always `docs/releases/next/`. It holds the notes for everything that has not shipped in a tagged
release yet, in three files:

```
docs/releases/next/
  breaking-changes.md   Changes that require admin action during or after the upgrade
  features.md           New capabilities and improvements (admin-facing and end-user-facing)
  fixes.md              Corrections to behaviour that was already supposed to work
```

Numbered directories (`docs/releases/5.5.7/`) are frozen. They hold exactly what shipped in that
release and are created by the release pipeline from `next/` when the tag is cut. Never write into
one, never invent a version number, never read `package.json` to pick one — the tag decides.

If `next/` is missing (a fresh clone of an older branch), create it with the three files, each
holding only its heading:

```markdown
# Features — Unreleased
```

```markdown
# Fixes — Unreleased
```

```markdown
# Breaking Changes — Unreleased
```

## Should This Be Documented at All?

Decide before writing. Skip when the answer to any of these is no:

1. **Is it visible?** Refactors, dependency bumps, test changes, comment- or docs-only changes and
   internal renames are not. Neither is a detail no admin or user would ever notice.
2. **Did the behaviour ship?** A fix for something that only exists in `next/` — a feature merged
   since the last tag, or introduced earlier in the same PR — is not a fix anyone experienced.
   Do **not** add a `fixes.md` entry for it. If the fix changes what the reader should know (a
   renamed setting, a limit, a default), edit the feature's existing entry; otherwise there is
   nothing to write.
3. **Is it already covered?** Read the target `next/` file first. One entry per capability per
   release: a second PR on the same feature extends the existing entry — add a bullet, sharpen
   the title — rather than adding a near-duplicate. Three entries titled "Answer-source badge fixed
   for …" are one entry.

Being asked to run this skill is not a reason to write something. "Nothing to document" is a
valid outcome — say so, and say why.

## Choosing the File

Pick by what the reader gets, not by how the work was labelled or which branch it came from:

| The change…                                                             | File                  |
| ----------------------------------------------------------------------- | --------------------- |
| lets someone do something they could not do before                      | `features.md`         |
| makes something existing faster, clearer, or easier — nothing was broken | `features.md`         |
| makes something work that was supposed to work already                  | `fixes.md`            |
| closes a security hole in shipped behaviour                             | `fixes.md`            |
| requires an admin to act during or after the upgrade                    | `breaking-changes.md` |

Two rules settle most of the hard cases:

- **One entry, one file.** A change that both fixes a bug and adds a capability goes wherever its
  headline belongs — do not write it twice. A breaking change is always documented as a breaking
  change, even when it is also a fix.
- **Titles say what is true now, not what was wrong.** Both files use the same voice, so
  "Chat exports no longer lose attachments" belongs in `fixes.md` on the strength of what it does,
  not because the title contains "no longer".

When it is genuinely ambiguous, ask: would an admin reading this be _relieved_ (fix) or
_interested_ (feature)? Relief goes in `fixes.md`.

## Entry Format

Each entry is a `##` heading followed by its text. The heading is the entry's identity: it becomes
the link in the table of contents, so keep it unique within the file and make it say what the
reader gets. Prefix the area when the title alone would not place it (`Workflow Editor: …`,
`Outlook Add-in: …`).

```markdown
## Short Title

One or two sentences describing what this does and why it matters to admins or users.

- Key detail 1
- Key detail 2

**Before upgrading:** Migration step if any (breaking changes only).
```

Inside an entry, use `###` for sub-sections, fenced code for configuration and commands, and a
`>` quote for error text verbatim. Never start a line inside an entry with `#` or `##` outside a
code fence — it would begin a new entry. Include a configuration or API example only when admins
need to take action.

## Writing Style

- **Audience:** admins and operators who read the in-product changelog. Not developers.
- **Tense:** present tense ("Admins can now…", "The sidebar now…").
- **Concise:** one paragraph plus bullets. No filler phrases, no implementation details.
- **Fixes name the symptom.** An admin recognises a bug by what they saw, not by its cause, so
  lead with the symptom and only then the reason: "The admin start page showed only grey
  placeholders on installations without internet access — the update check had no timeout."
- **Wrap at 100 columns.** The page renders Markdown, so a line break inside a paragraph is just
  wrapping.

## Workflow

1. Read the three files in `docs/releases/next/`.
2. Decide whether anything needs documenting (**Should This Be Documented at All?**).
3. Pick the file (**Choosing the File**).
4. Read the code changes to understand the user-visible impact.
5. Either extend the existing entry in place, or **append** the new `##` entry at the end of the
   file. Never reorder, merge or rewrite other entries.
6. For breaking changes: always include a **Before upgrading:** migration note.

## How Entries Become a Release

Creating a GitHub release for a tag runs `scripts/finalize-release-notes.js` in the release
workflows:

- The entries in `next/` at the tagged commit move to `docs/releases/<version>/` (only the files
  that have entries), and a commit lands on the default branch. Entries merged after the tag stay
  in `next/`.
- If `next/` has no entries, the release gets no directory and the changelog does not list it.
- `next/` is left in place with its three headings, ready for the next entry.

Details: `docs/release-process.md`.

## Plumbing

- `server/utils/releaseNotes.js` — parses the `##` entries and versions; shared by the endpoint,
  the release script and the tests.
- `server/routes/admin/changelog.js` — `GET /api/admin/changelog` (releases with counts) and
  `GET /api/admin/changelog/:version` (one release's entries).
- `client/src/features/admin/pages/AdminChangelogPage.jsx` — the page.
- `scripts/finalize-release-notes.js` — publishes `next/` under a tag.

A fourth section file would need `RELEASE_SECTIONS` in `releaseNotes.js`, the `SECTIONS` table in
the page and this document to know about it.
