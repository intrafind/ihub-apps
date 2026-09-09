/**
 * Storage abstraction — public surface.
 *
 * Import from here rather than from the individual modules: this is also the
 * one place that wires providers into the registry, so a caller that resolves
 * the configured provider always gets a fully populated registry.
 *
 * Nothing in the running server uses this yet. It is the foundation for
 * durable chats (issue stack in
 * `concepts/persistence-layer/2026-09-09 Storage Provider and Durable Chats Design.md`)
 * and ships inert: no existing code path was changed to go through it.
 *
 * @module storage
 */
import FilesystemStorageProvider from './providers/filesystem/index.js';
import { registerProvider } from './StorageRegistry.js';

export * from './errors.js';
export * from './StorageProvider.js';
export * from './DocumentStore.js';
export * from './AppendLog.js';
export * from './ChangeNotifier.js';
export * from './LockManager.js';
export * from './StorageRegistry.js';
export { FilesystemStorageProvider };

// The single registry side effect in the tree. Provider modules stay free of
// them so importing one (a test, a migration tool) cannot silently change which
// backend the process resolves.
registerProvider('filesystem', config => new FilesystemStorageProvider(config));
