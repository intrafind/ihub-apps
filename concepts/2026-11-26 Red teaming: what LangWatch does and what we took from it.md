# Red teaming: what LangWatch does and what we took from it

Date: 2026-11-26. Status: partly done; the open points are at the end.

## Why this note

We looked at the red teaming of [LangWatch](https://github.com/langwatch/langwatch) (open core: Apache-2.0 platform, an `enterprise/` folder under its own license) to see what we could learn for our nightly run (`tests/security/redteam/`, `.github/workflows/redteam.yml`).

## What they do

- **Attacks are multi-turn and written by a model.** There is no probe dataset. An attacker model works towards a goal with Crescendo (warm-up, probing, escalation, direct) or GOAT (seven techniques, one picked per turn). Single-turn encodings exist and are off by default.
- **Scoring:** a model rates each reply from 0 to 10, a phrase list catches hard refusals, and on a refusal the attacker backtracks. A run counts as broken when the judge fails it or the score hits 9 twice in a row.
- **Packs:** OWASP LLM Top 10 2025, the OWASP agentic list, PII and prompt injection. CI runs the CLI and fails on a break.
- **What they do not do:** indirect injection is only simulated by pasting a fake tool result into the chat; there is no hidden-text or real page-poisoning harness and no canary tokens. Their docs say the prompt-injection pack covers "tool output and retrieved documents", but its six attacks do not.

We read the code for the break score, the phases, the techniques, the encodings, the pack contents and the docs mismatch. We did not see their attack library (an npm package), any benchmark results or their default models.

## Where we stand

We are ahead on real indirect injection through the actual page reader, on where the text hides (six places, pinned by `server/tests/page-extraction-corpus.test.js`), on crafted-address exfiltration and on deterministic grading from the attacker's request log. They are ahead on adaptive attackers, on reports by OWASP id and on trends.

## What we took

| Idea | Where it is |
| --- | --- |
| Every test names the OWASP LLM Top 10 ids it speaks to; the job summary has a table by id | `owasp.mjs`, `owasp-summary.mjs`; `metadata.owasp` in both configs |
| Excessive agency: a page that asks for mail | `agency.mjs` (two pages), the canary's mail tool installed without a gate, `noCanaryRequests` |
| Unbounded consumption: an endless answer, a chain of pages | `agency.mjs` (two pages), `answerIsBounded`, the page-read limit in `noCanaryRequests` |
| Run only the failures again, to tell a one-off from a model that obeys every time | `--filter-failing ... --repeat 2` in the workflow; `rerun-summary.mjs` |

The flags of the re-run were read in the promptfoo 0.126.0 package that the workflow pins. No model endpoint was available while this was written, so the nightly workflow itself has not run with these steps; what was run is the iHub target with a scripted model (the mail tool installs, the user can use the new app, a call reaches the canary as `tools/call send_email`), and the unit tests of the graders and the summaries.

## Not done

- **An adaptive multi-turn attacker** for attacks in the user's own turns (persona drift, a payload split over turns). We cover none of that. Their GOAT technique list could become the prompt of an attacker model on our own GPU server. Open question: promptfoo's strategies need remote generation, which the workflow switches off, so the attacker would be our own script.
- **OWASP ids for the agentic list.** Only the LLM Top 10 ids are used; the agentic ids were not checked against the source.
- **Limits for the consumption pages are guesses** (6,000 characters, 100 repeats, 8 page reads). After a few nights the failing runs show whether they sit in the right place.
