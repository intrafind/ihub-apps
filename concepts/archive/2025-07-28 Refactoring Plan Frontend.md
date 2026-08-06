- **API Client Inconsistency:** `adminApi.js` uses the native `fetch` API, while `api/client.js` sets up a more robust `axios` client with interceptors for session management and error handling. All API calls should be standardized to use the `axios` client.

- **API Endpoints:** The API endpoint files are well-separated, but `misc.js` is a catch-all. Its functions could be regrouped into more logical files (e.g., a new `feedback.js` or `content.js`).
- **Canvas Hooks:** `useCanvasContent`, `useCanvasEditing`, and `useCanvasEditResult` are tightly coupled. They could be merged into a single `useCanvas` hook that returns a comprehensive API for managing the canvas, simplifying the `AppCanvas.jsx` component.

4.  **Standardize API Client:**
    - **Why:** To ensure consistent API behavior, error handling, and authentication across the entire application.
    - **How:**
      1.  Refactor `adminApi.js` to import and use the `apiClient` from `src/api/client.js` instead of `fetch`.
      2.  Remove the manual auth header and redirect logic from `makeAdminApiCall`, as this is handled by the `axios` interceptors.

5.  **Centralize Export Logic:**
    - **Why:** To remove duplicated code for exporting and copying chat/canvas content.
    - **How:**
      1.  Delete the local export/conversion functions (`asJSON`, `asMarkdown`, etc.) from `ExportConversationMenu.jsx`.
      2.  Modify the client-side export functions in `api/endpoints/apps.js` to accept `messages` and `settings` as arguments instead of being tied to a specific `appId` and `chatId`.
      3.  Import and use these centralized functions in `ExportConversationMenu.jsx`.
      4.  Create a shared hook, e.g., `useClipboard.js`, for the copy-to-clipboard logic used in both `ExportConversationMenu.jsx` and `ExportMenu.jsx`.

6.  **Refactor `AppChat.jsx` God Component:**
    - **Why:** To improve readability, testability, and separation of concerns.
    - **How:**
      1.  Create a new hook `useFileUploadHandler.js` that encapsulates the logic from `createUploadConfig` and `handleFileSelect`. It should return the `uploadConfig`, `selectedFile`, `handleFileSelect`, etc.
      2.  Create a new hook `useMagicPrompt.js` to manage the magic prompt state (`originalInput`, `magicLoading`) and logic (`handleMagicPrompt`, `handleUndoMagicPrompt`).
      3.  `AppChat.jsx` will then use these hooks, drastically simplifying its main body.

7.  **Refactor `AppCanvas.jsx` and its Hooks:**
    - **Why:** To simplify state management for the canvas feature.
    - **How:**
      1.  Merge the logic from `useCanvasContent.js`, `useCanvasEditing.js`, and `useCanvasEditResult.js` into a single, comprehensive `useCanvas.js` hook.
      2.  This new hook will manage `editorContent`, `selection`, `selectedText`, and expose handler functions like `handleSelectionChange`, `handleEditAction`, and `applyEditResult`.
      3.  Refactor `AppCanvas.jsx` to use this single hook, which will significantly reduce the amount of state and prop-drilling within it.

8.  **Fix DOM Manipulation in `ChatMessage.jsx`:**
    - **Why:** To follow React best practices and prevent bugs.
    - **How:**
      1.  In `ChatMessage.jsx`, add a `useRef` to the `div` that wraps the rendered markdown.
      2.  In the `useEffect` that adds `target="_blank"`, use the ref to scope the `querySelectorAll('a')` call to that specific message's container (e.g., `ref.current.querySelectorAll('a')`).

9.  **Abstract Admin List Pages:**
    - **Why:** To reduce boilerplate code for listing resources.
    - **How:**
      1.  Create a generic `useAdminResource.js` hook that handles fetching, deleting, and toggling a resource type (e.g., 'apps', 'models').
      2.  Refactor `AdminAppsPage.jsx`, `AdminModelsPage.jsx`, etc., to use this hook, simplifying their data management logic.
