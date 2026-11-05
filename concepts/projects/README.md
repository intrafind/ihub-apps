# Projects — Concept Documents

Design documents for the Projects epic
([intrafind/ihub-apps#1036](https://github.com/intrafind/ihub-apps/issues/1036)): the one
user-facing container that holds documents, instructions and chats, created by users or by
admins, and reached by chats, agents and workflows through one knowledge provider contract.

Phase 1 ships iHub local projects behind a feature flag and folds the admin sources system into
admin projects. These three specs gate that build. Specs 4 to 8 (encrypted blob storage and key
provider, iFinder uploads, iHub-to-iFinder mapping, UX, compliance) are tracked on the epic and
only referenced here where phase 1 has to leave a seam for them.

## Documents

- **[2026-10-20 Spec 1 Project model, API, sharing and lifecycle](./2026-10-20%20Spec%201%20Project%20model%2C%20API%2C%20sharing%20and%20lifecycle.md)**
  (#2903) — the entity, the item model, the item kind registry, the REST surface, storage
  namespaces, per-resource ACL, groups permission and feature flags, the sources migration with
  its breaking-change note, lifecycle and audit events.
- **[2026-10-20 Spec 2 Knowledge provider contract and tools](./2026-10-20%20Spec%202%20Knowledge%20provider%20contract%20and%20tools.md)**
  (#2904) — the `KnowledgeProvider` interface, the local BM25 provider on
  `server/sources/documentRetrieval.js`, the `knowledge_search`, `knowledge_read` and
  `knowledge_list` tools, the mapping onto the answer `Source` model, load-all versus search,
  workflow iteration and write-back, and what iFinder, OpenSearch or Qdrant implement later.
- **[2026-10-20 Spec 3 Upload and extraction pipeline](./2026-10-20%20Spec%203%20Upload%20and%20extraction%20pipeline.md)**
  (#2905) — the multipart upload route, the pick path, server-side extraction, item status, the
  `KeyProvider` and the encrypted text blob format, quotas, the malware scan hook and the
  reconciler.

## Inputs

- Epic #1036 with its decision log of 2026-10-20; sub-issues #2903, #2904, #2905, #2906, #2909,
  #2910.
- Review document "Knowledge Folders: Product Review" (2026-10-20).
- Answer sources contract #2637 (`shared/sources/`, `docs/answer-sources.md`).
- Storage provider design `concepts/persistence-layer/` and `docs/storage.md`.
- Prompt sharing model `server/services/prompts/userPromptAccess.js`, `docs/prompts.md`.

## Status

Written 2026-10-20 as the input to the phase 1 implementation slices (see the slice plan on
#1036). Every "must decide" item of the three sub-issues is resolved here with a concrete
proposal; the decisions a reviewer is most likely to challenge are collected in each spec's last
section.
