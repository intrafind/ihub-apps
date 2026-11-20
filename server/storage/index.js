// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Storage abstraction — public surface.
 *
 * Import from here rather than from the individual modules: this is also the
 * one place that wires providers into the registry, so a caller that resolves
 * the configured provider always gets a fully populated registry.
 *
 * The design is in
 * `concepts/persistence-layer/2026-09-09 Storage Provider and Durable Chats Design.md`.
 * Durable chats, the run ledger, workflow state, interactions and
 * configuration all read and write through this seam; a provider that fails to
 * come up is not fatal to any of them, because each keeps its previous on-disk
 * layout as a supported fallback.
 *
 * @module storage
 */
import FilesystemStorageProvider from './providers/filesystem/index.js';
import { registerProvider } from './StorageRegistry.js';
import { registerBlobBackend } from './blobBackends.js';
import { createS3BlobBackend } from './providers/s3/index.js';

export * from './errors.js';
export * from './StorageProvider.js';
export * from './DocumentStore.js';
export * from './BlobStore.js';
export * from './AppendLog.js';
export * from './ChangeNotifier.js';
export * from './LockManager.js';
export * from './StorageRegistry.js';
export * from './blobBackends.js';
export * from './blobProbe.js';
export { ComposedStorageProvider } from './ComposedStorageProvider.js';
export { EncryptingBlobStore, isBlobEnvelope } from './EncryptingBlobStore.js';
export { encryptExistingBlobs } from './encryptExistingBlobs.js';
export { findLocalBlobLeftovers } from './localBlobLeftovers.js';
export { FilesystemStorageProvider };

// The single registry side effect in the tree. Provider modules stay free of
// them so importing one (a test, a migration tool) cannot silently change which
// backend the process resolves.
registerProvider('filesystem', config => new FilesystemStorageProvider(config));

// Blobs in an S3-compatible bucket, always behind the encrypting blob store.
// Importing the backend does not load the AWS SDK; the client module does
// that when the backend connects.
registerBlobBackend('s3', createS3BlobBackend);
