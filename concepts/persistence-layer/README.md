# Persistence Layer — Concept Documents

This folder contains design documents for the pluggable persistence layer initiative.

## Documents

- **[2026-03-18 Pluggable Persistence Layer PRD](./2026-03-18%20Pluggable%20Persistence%20Layer%20PRD.md)** — Comprehensive product requirements document covering the storage abstraction, five provider implementations (Filesystem, SQLite, PostgreSQL, OpenSearch, S3), change propagation, migration strategy, and extensibility guide.

## Context

iHub Apps currently stores all configuration as JSON files on disk. This limits horizontal scaling because there is no distributed cache invalidation or coordinated writes. The persistence layer introduces a `StorageProvider` interface that decouples iHub from the filesystem, enabling database and object-store backends for production multi-instance deployments.
