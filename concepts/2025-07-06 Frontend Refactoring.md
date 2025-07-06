## **AI Code Refactoring and Cleanup Task List**

This document outlines a series of tasks to improve the codebase by removing unused code, completing unfinished features, and optimizing performance and maintainability.

### **Part 1: Tasks for Removing Unused Code**

These tasks focus on identifying and deleting dead code to reduce complexity and improve bundle size.

---

#### **Task 1.1: Remove Unused `loadEnv` Import**

*   **Description:** In `vite.config.js`, the `loadEnv` function is imported from "vite" but is never used. Please remove this import.
*   **Files to Modify:**
    *   `vite.config.js`

---

#### **Task 1.2: Remove Unused `getMap` Logic from `recentItems`**

*   **Description:** The `getMap` function in `src/utils/recentItems.js` is exported but never consumed by its intended users (`recentApps.js` and `recentPrompts.js`). This makes the `getRecentAppsMap` and `getRecentPromptsMap` exports unused as well.
    1.  In `src/utils/recentItems.js`, remove `getMap` from the object returned by `createRecentItemHelpers`.
    2.  In `src/utils/recentApps.js`, remove `getRecentAppsMap` from the import and the export.
    3.  In `src/utils/recentPrompts.js`, remove `getRecentPromptsMap` from the import and the export.
*   **Files to Modify:**
    *   `src/utils/recentItems.js`
    *   `src/utils/recentApps.js`
    *   `src/utils/recentPrompts.js`

---

#### **Task 1.3: Remove Unused `isMarkdown` Function**

*   **Description:** The `isMarkdown` function in `src/utils/markdownUtils.js` is defined and exported but is not used anywhere in the application. Please remove the entire function.
*   **Files to Modify:**
    *   `src/utils/markdownUtils.js`

---

#### **Task 1.4: Clean Up Unused Methods and Keys in the Cache Utility**

*   **Description:** The `Cache` class in `src/utils/cache.js` defines several public methods that are never called (`getStats`, `has`, `invalidateByPattern`, `destroy`). Additionally, the `CACHE_KEYS` object contains keys that are not used by the application (`MODEL_DETAILS`, `PAGE_CONTENT`, `TRANSLATIONS`). Please remove these unused methods from the `Cache` class and the specified keys from the `CACHE_KEYS` object.
*   **Files to Modify:**
    *   `src/utils/cache.js`

---

#### **Task 1.5: Delete the Unused `useLocalizedTranslation` Hook**

*   **Description:** The file `src/hooks/useLocalizedTranslation.js` defines a custom hook that is never used in the project. The application consistently uses the standard `useTranslation` hook from `react-i18next`. Please delete this entire file as it is dead code.
*   **Files to Modify:**
    *   Delete the file: `src/hooks/useLocalizedTranslation.js`

---

#### **Task 1.6: Remove Unused Ref in `ChatMessageList.jsx`**

*   **Description:** In `src/components/chat/ChatMessageList.jsx`, the ref `lastMessageIdRef` is initialized with `useRef` but it is never read from or written to. Please remove this unused ref.
*   **Files to Modify:**
    *   `src/components/chat/ChatMessageList.jsx`

---

### **Part 2: Tasks for Completing Unfinished Features**

These tasks address parts of the code that are incomplete, contain placeholder logic, or are not fully implemented.

---

#### **Task 2.1: Correct Logic in Azure Speech Recognition Service**

*   **Description:** The `AzureSpeechRecognition` class in `src/utils/azureRecognitionService.js` has conflicting logic. It uses single-shot recognition (`recognizeOnceAsync`) but has properties and methods for continuous recognition.
    1.  The `stop()` method calls `stopContinuousRecognitionAsync`, which will fail. Since continuous mode is not used, remove the `stop()` method entirely.
    2.  The `continuous` and `interimResults` class properties are not used by the single-shot recognition. Remove these properties.
*   **Files to Modify:**
    *   `src/utils/azureRecognitionService.js`

---

#### **Task 2.2: Implement Proper Markdown Conversion in Export Menu**

*   **Description:** The `handleCopyMarkdown` function in `src/components/canvas/ExportMenu.jsx` uses a primitive and unreliable series of `replace()` calls. The project already includes the `turndown` library for this purpose. Refactor this function to use `TurndownService` for robust HTML-to-Markdown conversion.
    1.  Import `TurndownService` at the top of the file.
    2.  Instantiate it: `const turndownService = new TurndownService();`.
    3.  In `handleCopyMarkdown`, replace the `replace()` chain with a call to `turndownService.turndown(content)`.
*   **Files to Modify:**
    *   `src/components/canvas/ExportMenu.jsx`

---

#### **Task 2.3: Mark Unfinished Link Input in Quill Toolbar**

*   **Description:** The link insertion button in `src/components/canvas/QuillToolbar.jsx` uses a native `window.prompt()`, which is a placeholder for a proper UI. This feature is considered unfinished. To mark this for future improvement, please add a `// TODO:` comment above the line with `prompt('Enter URL:')`. The comment should read: `// TODO: Replace with a proper UI modal for link input.`
*   **Files to Modify:**
    *   `src/components/canvas/QuillToolbar.jsx`

---

#### **Task 2.4: Fix Incorrect Logic in Floating Toolbox**

*   **Description:** In `src/components/canvas/FloatingToolbox.jsx`, the logic to disable tools is inverted. It disables tools like 'continue' and 'summarize' *when* text is selected, which is incorrect. These tools should be disabled when *no* text is selected. Modify the `disabled` attribute on the tool button to correctly reflect this logic. The condition should disable the button if the tool is *not* in the `noSelectionActions` array and `hasSelection` is `false`.
*   **Files to Modify:**
    *   `src/components/canvas/FloatingToolbox.jsx`

---

### **Part 3: Tasks for Optimizing and Refactoring Code**

These tasks focus on improving performance, maintainability, and architectural patterns.

---

#### **Task 3.1: Refactor `ChatWidget.jsx` to Remove Global State**

*   **Description:** A critical issue exists in `src/components/widget/ChatWidget.jsx` where component state is managed on the global `window` object (`window.lastMessageId`, `window.pendingMessageData`). This is a major anti-pattern. Refactor this component to use `useRef` for these values to ensure they are scoped to the component instance and do not cause unpredictable side effects.
    1.  Create refs: `const lastMessageIdRef = useRef(null);` and `const pendingMessageDataRef = useRef(null);`.
    2.  Replace all occurrences of `window.lastMessageId` with `lastMessageIdRef.current`.
    3.  Replace all occurrences of `window.pendingMessageData` with `pendingMessageDataRef.current`.
*   **Files to Modify:**
    *   `src/components/widget/ChatWidget.jsx`

---

#### **Task 3.2: Optimize Cache Storage Writes**

*   **Description:** The `saveToStorage` method in `src/utils/cache.js` is called on every `set` and `delete` operation, causing a significant performance bottleneck by writing the entire cache to `sessionStorage` repeatedly. This should be debounced.
    1.  In the `Cache` class, add a new property `this.saveTimeout = null;`.
    2.  Create a new private method `debouncedSaveToStorage()`. Inside this method, clear any existing timeout (`clearTimeout(this.saveTimeout);`) and set a new one: `this.saveTimeout = setTimeout(() => this.saveToStorage(), 500);`.
    3.  In the `set`, `delete`, and `cleanup` methods, replace the direct calls to `this.saveToStorage()` with `this.debouncedSaveToStorage()`.
*   **Files to Modify:**
    *   `src/utils/cache.js`

---

#### **Task 3.3: Consolidate `SmartSearch` and `PromptSearch` into a Reusable Component**

*   **Description:** The components `SmartSearch.jsx` and `PromptSearch.jsx` are nearly identical. To reduce code duplication, create a generic, reusable search modal.
    1.  Create a new file: `src/components/SearchModal.jsx`.
    2.  Implement a generic search modal component in this new file. It should accept props like `isOpen`, `onClose`, `onSelect`, `items` (the data array), `fuseKeys` (for Fuse.js), `placeholder`, and a `renderResult` function.
    3.  Refactor `SmartSearch.jsx` to use this new `SearchModal`, passing in app-specific data and a render function for app results.
    4.  Refactor `PromptSearch.jsx` to use this new `SearchModal`, passing in prompt-specific data and a render function for prompt results.
*   **Files to Modify:**
    *   `src/components/SmartSearch.jsx`
    *   `src/components/PromptSearch.jsx`
    *   Create new file: `src/components/SearchModal.jsx`

---

#### **Task 3.4: Refactor `MarkdownRenderer.jsx` to Avoid Side-Effect Rendering**

*   **Description:** `MarkdownRenderer.jsx` and `StreamingMarkdown.jsx` have a confusing dependency where they render each other simply to trigger a `useEffect` that calls `configureMarked()`. This is an anti-pattern. The `configureMarked()` function should be called once when the application initializes.
    1.  Move the `configureMarked()` function from `MarkdownRenderer.jsx` to `src/App.jsx`.
    2.  In `App.jsx`, call `configureMarked()` inside a `useEffect` hook with an empty dependency array `[]` so it runs only once on mount.
    3.  In `MarkdownRenderer.jsx`, remove the `useEffect` that calls `configureMarked()`. The component should now be `null` or an empty fragment, effectively becoming a headless component that only exists to export the configuration function.
    4.  In `StreamingMarkdown.jsx`, remove the import and rendering of `<MarkdownRenderer />`.
*   **Files to Modify:**
    *   `src/components/MarkdownRenderer.jsx`
    *   `src/components/chat/StreamingMarkdown.jsx`
    *   `src/App.jsx`

---

#### **Task 3.5: Simplify Placeholder Logic in `ChatInput.jsx`**

*   **Description:** The component `src/components/chat/ChatInput.jsx` uses a `useRef` and a `useEffect` hook (`placeholderRef`) to manage the `placeholder` text of the `textarea`. This is overly complex. The `placeholder` attribute can be set directly in the JSX.
    1.  Remove the `placeholderRef` and its associated `useEffect` hook.
    2.  Set the `placeholder` attribute on the `<textarea>` element directly to the `defaultPlaceholder` variable.
*   **Files to Modify:**
    *   `src/components/chat/ChatInput.jsx`