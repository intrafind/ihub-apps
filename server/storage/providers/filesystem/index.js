/**
 * Filesystem storage provider — module entry point.
 *
 * Importing this module has no side effects on the storage registry: the
 * `registerProvider('filesystem', …)` call lives in `server/storage/index.js`
 * alone, so importing the provider directly (a test, a maintenance script)
 * can never change which backend the process resolves.
 *
 * @module storage/providers/filesystem
 */
import FilesystemStorageProvider from './FilesystemStorageProvider.js';

export {
  FilesystemStorageProvider,
  resolveFilesystemBaseDir
} from './FilesystemStorageProvider.js';
export { FilesystemDocumentStore } from './FilesystemDocumentStore.js';
export { FilesystemAppendLog } from './FilesystemAppendLog.js';
export { FilesystemChangeNotifier } from './FilesystemChangeNotifier.js';
export { FilesystemLockManager } from './FilesystemLockManager.js';

export default FilesystemStorageProvider;
