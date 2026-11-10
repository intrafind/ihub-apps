# Artifact creation progress (issue #3534)

Design documents for showing progress while a model writes the arguments of a long tool call
(`create_web_artifact`, `create_docx`, …) and while it shows nothing at all. Implemented in
[PR #3535](https://github.com/intrafind/ihub-apps/pull/3535).

**Start with [04-decisions-and-contract.md](04-decisions-and-contract.md).** It is the reconciled
result, and where it differs from the three briefs it wins: the release order, the repeat label
("No. 2"), the file name, the announce rule (`outputKind`), reasoning not counting as visible output.
The wire contract in it matches `docs/sse-v2.md` and the code.

| Document | Author's lens | Read it for |
| --- | --- | --- |
| [01-product-brief.md](01-product-brief.md) | Product | The problem, the evidence from the reported chat, what is in and out of scope, the risks (R-numbers), the later briefs (P15, R2a) |
| [02-ux-brief.md](02-ux-brief.md) | UX | States, copy, timing, screen-reader behaviour, keyboard and motion |
| [03-ui-spec.md](03-ui-spec.md) | UI | Components, tokens, layout, the row and headline anatomy |

The three briefs were written before the build and still hold the options that were rejected
("Still working…", an "(2)" suffix, a 90 s stall caption, reasoning counted as visible output). Treat a
statement in them that 04 contradicts as superseded.
