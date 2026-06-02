---
name: document-feature
description: Use when a new feature, improvement, or breaking change has been implemented. Adds an entry to docs/releases/ so it appears in the in-product admin changelog.
user-invocable: true
---

# Release Documentation

When a feature, improvement, or breaking change is implemented, add an entry to the appropriate
Markdown file under `docs/releases/`.

## Determining the Version

Read the current version from `server/package.json` → `version` field.
If the version contains a build suffix (e.g. `fix-issue-1137-lVuXg`) look for the nearest clean
semver tag in the git log: `git tag --sort=-version:refname | head -5`.
Use the highest existing `docs/releases/` subdirectory name as a fallback.

## Directory Structure

```
docs/releases/{version}/
  features.md         New capabilities (admin-facing and end-user-facing)
  breaking-changes.md Changes that require admin action after upgrade
```

If the version directory does not exist yet, create it and both files with an empty heading:

```markdown
# Features — {version}
```

```markdown
# Breaking Changes — {version}
```

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

## Workflow

1. Identify the version (see above).
2. Read the existing `features.md` for that version to avoid duplication.
3. Read the code changes to understand the user-visible impact.
4. Append the new `##` entry to the appropriate file.
5. For breaking changes: always include a **Before upgrading:** migration note.

## When to Use

Use this skill proactively whenever you implement:

- A new admin page, section, or feature
- A change to configuration schema (new fields, renamed fields, removed fields)
- A change to API behavior that operators rely on
- A security improvement or bug fix that users/admins would want to know about
- Anything that appears in the admin "Needs your attention" feed

Skip for: pure refactors with no visible behavior change, dependency bumps, test additions,
comment/documentation-only changes.
