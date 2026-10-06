# Executable Skills: Sandbox & Trust Model

**Date:** 2026-10-06
**Status:** Proposal / decision doc. No code change proposed here beyond §3 (best-practice
polish, safe to do now). §4–§6 are a decision to take before any script execution ships.
**Related:** `concepts/2026-10-03 Skills Next - Invocation, Stacking, Scheduling and Chaining.md`
(gap G7 decided "scripts stay non-executable"), `concepts/2026-02-22 Agent Skills Integration PRD.md`,
`docs/skills.md`, `server/services/skillLoader.js`, the Agent Skills spec (agentskills.io/specification).

## 1. Why this doc

Two questions came up: (a) should iHub adopt the best practices published at agentskills.io, and
(b) should skills be able to **run code** (Deno, Bun, or similar)? This doc separates them because
they carry very different risk:

- **(a) is mostly already done** and the rest is low-risk polish (§3).
- **(b) is a deliberate reversal** of a decision iHub already took on purpose, and it is a security
  decision, not a feature toggle (§4–§6). "Run with Deno/Bun" is the right *instinct* but the wrong
  *framing*: the runtime is the smallest part of the problem; the trust model is the hard part.

## 2. Where iHub stands today

iHub is already a near-complete implementation of the Agent Skills spec, behind the `skills`
feature flag (preview, off by default). Progressive disclosure, the `SKILL.md` frontmatter
(`name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`), token budgets
(`skills.maxCatalogTokens` 3000, `skills.maxSkillBodyTokens` 5000), the `references/ assets/
scripts/` layout, name/description validation, personal + global + marketplace skills — all present.

Two facts matter for this doc:

1. **Scripts are never executed.** `skillLoader` reads `scripts/` as UTF-8 text; `docs/skills.md`
   states "Scripts are never run"; the Skills Next review (G7) decided this explicitly:
   *"Scripts stay non-executable. Skills that need computation should use tools."*
2. **`allowed-tools` already means iHub tools.** `parseAllowedTools()` maps the frontmatter field
   to iHub tool ids (MCP / built-in tools), not to shell or runtime permissions. So the computation
   path already exists and is already the design: **a skill that needs to compute calls a vetted
   tool.** The shipped `pdf` *system skill* is the model — computation happens in reviewed server
   code (`PdfService` worker), not in skill-bundled scripts.

There is **no code-execution sandbox primitive in the repo** to build on today (no `isolated-vm`,
no container-exec layer; `worker_threads` is used only for first-party PDF work).

## 3. Best-practice polish (safe, do now — independent of §4)

These close the remaining gaps against agentskills.io and Gemini parity. None changes the security
posture; most are already tracked in Skills Next as G7/G8/B9.

| Item | What | Source |
|---|---|---|
| **Binary-safe + recursive reference files** | `references/`/`assets/` read recursively; non-text files go through the document pipeline; marketplace install fetches as `arrayBuffer` (today `res.text()` corrupts binaries) | G7 |
| **Escape names/descriptions** | XML-escape skill `name`/`description` before injecting into the system prompt | B9 |
| **`skills-ref` validation parity** | Mirror the spec's `skills-ref validate` checks (frontmatter, naming, consecutive-hyphen rule, `name` must equal directory) on import and on save | spec §Validation |
| **Localized display metadata** | `metadata.ihub.displayName.<lang>` / `description.<lang>` for the picker; English `description` still drives model selection | G8 |
| **`compatibility` type consistency** | Loader treats it as a string, admin UI as an object (B9) — pick one (string, per spec) | B9 |

These are the "adopt the best practices" answer. They should land as one focused PR, separate from
anything in §4.

## 4. The executable-skills question

### 4.1 Two hard constraints that frame the whole decision

**Constraint A — the ecosystem is mostly bash + Python, not JS.** The large published skill sets
(Google's ~150, Anthropic's) are overwhelmingly `bash` + `Python`/`uv` + CLIs (`gcloud`, `jq`…).
The spec's own `compatibility` examples are *"Requires Python 3.14+ and uv"*, *"Requires git, docker,
jq, and access to the internet"*. iHub's own marketplace PR **deliberately excluded** the Google
skills "that mainly drive gcloud, MCP servers or scripts." **Consequence:** a Deno/Bun runner only
unlocks JS/TS skills — a minority. Supporting the real executable-skill ecosystem means a POSIX
sandbox with a shell and Python, not a JS runtime. Choose the scope deliberately; don't let "run
with Deno" quietly become "run arbitrary shell."

**Constraint B — skill authors are untrusted.** Any signed-in user can author a personal skill, and
marketplace skills come from third parties. Executing *their* bundled code on the server is
categorically different from reading text, and it collides head-on with iHub's security properties:
secret encryption at rest (`contents/.encryption-key`), the multi-mode auth + hierarchical group
model, and per-tenant isolation. Script execution must never become a path to any of those.

### 4.2 Trust tiers (the core of the design)

Eligibility to execute is a property of **where the skill comes from**, not what it declares.

| Tier | Source | Execute? |
|---|---|---|
| **0 — System** | Shipped in `server/systemSkills/` (e.g. `pdf`), code-reviewed, part of the build | Yes — via reviewed first-party helpers (already how `pdf` works) |
| **1 — Admin global** | `contents/skills/<name>/`, installed by an admin from a vetted source | Only behind an **explicit per-skill admin opt-in** + sandbox (§4.3) |
| **2 — Marketplace** | Third-party registries | **Never auto-execute.** Must be promoted to a reviewed Tier-1 global skill and opted in first |
| **3 — User / personal** | Authored by any signed-in user | **Never execute.** Computation stays on tools |

This preserves the existing rule (user + marketplace code is read, not run) and adds execution only
where an admin has taken explicit responsibility.

### 4.3 Isolation: the runtime is the easy part

For any Tier-0/1 skill opted in to execute, run each invocation in a **fresh, ephemeral, isolated
sandbox** — not just a runtime flag. Requirements:

- **No mount of `contents/`**, no access to `contents/.encryption-key`, no decrypted platform
  secrets, no storage-provider credentials, no server process env. The sandbox gets its own minimal
  env and only the inputs the skill is handed.
- **Egress deny-by-default**, per-host allowlist derived from `compatibility` / the platform network
  policy. The sandbox composes with the platform network policy — it must not bypass it.
- **Read-only rootfs + a tmpfs scratch dir**, non-root UID, dropped capabilities,
  `no-new-privileges`, seccomp profile.
- **Hard limits:** CPU/memory via cgroups, wall-clock timeout, output size cap.

Runtime choices, layered:

- **Deno** — the right JS/TS tier. Its deny-by-default permission flags
  (`--allow-net=host`, `--allow-read=path`, `--allow-write=path`, `--deny-*`) are good
  defense-in-depth. Caveat: Deno permissions are **not** a hardened boundary against a V8 exploit —
  Deno's own guidance is to add OS-level isolation for untrusted code. Treat Deno permissions as a
  second layer *inside* §4.3's container, not as the boundary.
- **Bun** — fast, Node-compatible, **no permission sandbox**. Only a "speed inside the container"
  choice; never a boundary on its own.
- **Python** — the one the ecosystem actually needs. Either (i) subprocess + `uv` inside the
  container, or (ii) **Pyodide/WASM** in a worker for strong isolation when the skill only *computes
  over provided data* (no native wheels, no real FS/net). Pyodide is the safest option for the
  "compute, don't shell out" subset and may be enough for many real cases.
- **Arbitrary POSIX isolation** (if shell skills are in scope): gVisor (`runsc`), Firecracker
  microVM, or `nsjail`/bubblewrap. Plain Docker is **not** a sufficient boundary for untrusted code.

### 4.4 Declaring capabilities — don't overload `allowed-tools`

`allowed-tools` already means iHub tool ids (§2); reusing it for "may run shell / may reach the
network" would be ambiguous. Use the spec's `compatibility` (free text, intended for "required
system packages, network access needs") for human/admin review, and a reserved
`metadata.ihub.execution` namespace for the machine-checked capability request (runtime, declared
network hosts, declared packages). The admin opt-in is the gate; the declaration only *informs* it.

### 4.5 The cheaper alternative, stated plainly

Every candidate "skill that needs to execute code" should first pass this test: **could a vetted MCP
or built-in tool do this instead?** If yes, that path already exists, already maps from
`allowed-tools`, already runs in reviewed code, and carries none of §4.1–§4.3's risk. The `pdf`
system skill shows the pattern works. Reserve the sandbox for the residue that genuinely cannot be a
tool.

## 5. Options & recommendation

- **Option A — keep scripts non-executable; route computation through tools (recommended default).**
  Matches the standing G7 decision, keeps user + marketplace skills safe by construction, zero new
  attack surface. Pair with §3 polish.
- **Option B — gated execution sandbox**, Tier-0/1 only, admin opt-in per skill, §4.3 isolation,
  Pyodide/Deno first and POSIX isolation only if shell skills are truly required. Take this **only**
  if concrete, named skills survive the §4.5 test and the sandbox is budgeted as the security project
  it is — not bolted onto the loader.

**Recommendation:** adopt §3 now; default to Option A; treat Option B as a separately-scoped,
security-reviewed project entered only behind a real need. Do **not** ship "run scripts" as a
quiet loader change.

## 6. Phasing

| Phase | Content | Risk |
|---|---|---|
| **P1 — Polish** | §3 (G7 binary-safe/recursive files, B9 escaping, `skills-ref` parity, localized metadata, `compatibility` type) | Low |
| **P2 — Decide** | Confirm Option A as default; collect candidate skills that would need execution and run them through §4.5 | None |
| **P3 — Spike (only if P2 yields real need)** | Sandbox prototype for **Tier-0/1 only**: Pyodide/Deno runner inside §4.3 isolation, admin opt-in, no `contents/` access, egress deny-by-default. Security review before any marketplace/user tier is ever considered | High — gated |

## 7. Open questions

1. **Is there a concrete first skill that needs execution and cannot be a tool?** If not, P3 does not
   start. (Drives the whole decision.)
2. **Pyodide-only first?** The "compute over provided data" subset may cover most real needs with far
   less risk than a POSIX sandbox. Decide whether shell/`gcloud`-style skills are in scope at all.
3. **Network policy composition.** How does a per-skill egress allowlist compose with the
   environment's existing network policy — strict intersection (safer) assumed here.
4. **Audit & limits.** Per-execution audit entries, and where runtime/CPU/egress limits live
   (`platform.skills` vs a new `platform.skillExecution`).
