import { createAppConfig } from '@nextcloud/vite-config'

// Two entry points:
//   src/main.ts        → js/ihub_chat-main.mjs        (iframe host page)
//   src/files-init.ts  → js/ihub_chat-files-init.mjs  (Files-page file action)
//
// Output names follow the @nextcloud/vite-config convention:
//   js/<appName>-<entryKey>.mjs
// `Util::addScript('ihub_chat', '<filename-without-.mjs>')` in PHP loads them.
export default createAppConfig({
  main: 'src/main.ts',
  'files-init': 'src/files-init.ts',
})
