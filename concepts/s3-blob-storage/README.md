# S3 Blob Storage and Storage Encryption — Concept Documents

Design and hand-over documents for two features that were built together on branch
`claude/epic-lamport-5wjqa7`: an S3-compatible backend for blobs (uploaded files, extracted text,
artifacts, evidence content, crawled pages) and optional encryption of everything iHub stores.
Tickets: #2318, #2316, #2906, #2302, #2312.

The operator documentation is not here. It is in `docs/storage.md` (section "Blob storage
backends"), `docs/storage-encryption.md` and `docs/encryption-key-management.md`. Where a concept
document and the code disagree, the code is right.

## Documents

- **[2026-11-19 S3 Blob Storage Backend](./2026-11-19%20S3%20Blob%20Storage%20Backend.md)** — The
  design. Sections 1 to 10 are the plan of seven roles with the lead's decisions (D1 to D19).
  Section 11 records what the requester changed afterwards (R1 to R3) and where the code differs
  from the plan. Read section 11 before you rely on a decision: D2 ("always encrypted on S3, no
  off switch") was changed by R1 and R3.
- **[2026-11-20 Storage Encryption at Rest](./2026-11-20%20Storage%20Encryption%20at%20Rest.md)** —
  The design of the encryption as it was built: the one switch `storage.encryption.enabled`, what
  is and is not encrypted, the formats, the one-time conversion of existing data, and the
  follow-ups. Start here for anything about encryption; the first document only has the plan for
  S3 objects.
- **[2026-11-20 S3 Blob Storage Test Suites](./2026-11-20%20S3%20Blob%20Storage%20Test%20Suites.md)** —
  Hand-over notes for the tests: which file tests what, the two S3 servers (the in-repository
  fake and versitygw), how a suite selects its server, and the rules for adding tests.

## Where to start

| You want to… | Read |
| --- | --- |
| understand why S3 holds only blobs, and how objects are named and deleted | Backend, sections 3 and 4 |
| know what the encryption switch covers and what happens when it is turned on | Encryption at Rest |
| add or run a storage test | Test Suites |
| know what was never verified (AWS S3, versitygw, the CI workflow) | Backend, section 11.3 |

## Related

- `concepts/persistence-layer/` — the storage provider abstraction these features build on.
- `concepts/2026-02-02 Encryption Key Persistence Migration.md` — where the master key file comes
  from.
