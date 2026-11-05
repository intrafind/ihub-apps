# Error response shape: readers of the old shapes

Inventory for #3231, first PR. Counts are matching lines (files in brackets); `rg`-style patterns are in the table header. Teams reuses the main client (`client/src/features/teams`); `teams/` holds only manifests. `client/office`, `client/extension` and `client/nextcloud` are entry points that import `client/src`; their own files read no error bodies. `browser-extension/background.js` and `nextcloud-app` read none either.


## What the new shape drops or moves

New body: `{ "error": <English fallback>, "code": <registry code>, "details"?: { ...params } }`.

| Old shape | Readers | Consequence |
|---|---|---|
| `{ error }` | ~53 files read `error` | Nothing breaks: `error` stays. They keep working until a route converts and the reader switches to `code` + i18n. |
| `{ error, details: { code, ... } }` | 8 files read `details.code` (`chatFileUpload`, `skillErrors`, `promptErrors`, `fileErrors`, `userSkills`, `projectAdmin`, `textPreview`, `projectErrors`) | `code` moves to the top level and `details` loses `code`. Every one of them already falls back to `data.code` or is the reader of exactly one route family, so each changes in the PR of its route. |
| `{ error, code }` (flat) | 21 files | Unchanged location. |
| `{ error, details: [...] }` (validation, `validate.js`) | `details` read as data in 11 files, none as an array of zod issues except the integration install form/editor | `details` becomes an object (`{ issues: [...] }`). Converted together with `validate.js`. |
| `{ success: false, error }` | none read it on an HTTP error (the two `success === false` reads are on 200 bodies: `AdminUpdatesPage`, `BuilderActionsStep`) | `success` is not kept. |
| `{ message }` on 401 | `requestHandler.js`, `AgentRunDetailPage`, `MyExecutionsTab` | Read as an optional better text; falls back to `error`. |

OAuth (`/api/oauth/*`, `/.well-known/*`) keeps `{ error, error_description }`.

## Reads `error` text of the body (`data.error`, `response.data.error`, `errorData.error`)

Pattern: `(response\??\.data|errorData|\bdata|body|result|json)\??\.error\b`

- `client/src`: 77 lines in 53 files

<details><summary>Files</summary>

- `client/src/features/office/utilities/outlookMailActions.js` (8)
- `client/src/api/utils/requestHandler.js` (4)
- `client/src/features/admin/pages/AdminProvidersPage.jsx` (3)
- `client/src/features/admin/pages/AdminModelsPage.jsx` (3)
- `client/src/shared/contexts/AuthContext.jsx` (2)
- `client/src/features/admin/components/ProjectTestResults.jsx` (2)
- `client/src/features/admin/components/integrations/ActionTestPanel.jsx` (2)
- `client/src/features/admin/pages/AdminAuditLogPage.jsx` (2)
- `client/src/features/admin/pages/AdminCredentialsPage.jsx` (2)
- `client/src/features/voice/utils/speechQueue.js` (2)
- `client/src/features/settings/pages/IntegrationsPage.jsx` (2)
- `client/src/features/office/utilities/outlookMailContext.js` (2)
- `client/src/features/office/utilities/officeLog.js` (2)
- `client/src/features/tools/pages/OcrPage.jsx` (2)
- `client/src/shared/components/MemoryEditor.jsx` (1)
- `client/src/auth-gate/auth-gate.js` (1)
- `client/src/api/adminApi.js` (1)
- `client/src/api/endpoints/exports.js` (1)
- `client/src/features/admin/components/marketplace/MarketplaceItemDetail.jsx` (1)
- `client/src/features/admin/components/tts/TtsVoicesPanel.jsx` (1)
- `client/src/features/admin/components/usage/UsageUi.jsx` (1)
- `client/src/features/admin/components/updates/InstallFromFileCard.jsx` (1)
- `client/src/features/admin/components/ModelImportDialog.jsx` (1)
- `client/src/features/admin/components/integrations/migrationState.js` (1)
- `client/src/features/admin/pages/AdminChatHistoryPage.jsx` (1)
- `client/src/features/admin/pages/AdminUpdatesPage.jsx` (1)
- `client/src/features/admin/pages/AdminAgentApprovalsPage.jsx` (1)
- `client/src/features/admin/pages/AgentRunDetailPage.jsx` (1)
- `client/src/features/admin/pages/AdminOAuthClientsPage.jsx` (1)
- `client/src/features/admin/pages/AdminMcpGatewayPage.jsx` (1)
- `client/src/features/admin/pages/AdminAgentInboxEditPage.jsx` (1)
- `client/src/features/teams/TeamsTab.jsx` (1)
- `client/src/features/projects/utils/projectErrors.js` (1)
- `client/src/features/voice/utils/voiceSession/azureAdapter.js` (1)
- `client/src/features/voice/utils/pcmStreamPlayer.js` (1)
- `client/src/features/workflows/components/StartWorkflowModal.jsx` (1)
- `client/src/features/workflows/hooks/useWorkflowList.js` (1)
- `client/src/features/workflows/hooks/useWorkflowExecution.js` (1)
- `client/src/features/workflows/hooks/useMyExecutions.js` (1)
- `client/src/features/workflows/pages/WorkflowExecutionPage.jsx` (1)
- `client/src/features/workflows/pages/MyExecutionsTab.jsx` (1)
- `client/src/features/upload/hooks/useCloudStorageBrowser.js` (1)
- `client/src/features/chat/components/ChatSharePanel.jsx` (1)
- `client/src/features/chat/mcpApps/McpAppView.jsx` (1)
- `client/src/features/chat/mcpApps/McpAppHostBridge.js` (1)
- `client/src/features/settings/components/AvailableIntegrations.jsx` (1)
- `client/src/features/settings/components/RequestableIntegrations.jsx` (1)
- `client/src/features/integrations/connect/ConnectCard.jsx` (1)
- `client/src/features/office/utilities/outlookAttachments.js` (1)
- `client/src/features/office/utilities/officePopout.js` (1)
- `client/src/features/office/utilities/officePopoutChild.js` (1)
- `client/src/features/setup/SetupWizard.jsx` (1)
- `client/src/utils/azureRecognitionService.js` (1)

</details>

## Reads a flat `code` (`data.code`, `response.data.code`)

Pattern: `(response\??\.data|errorData|\bdata|body)\??\.code\b`

- `client/src`: 22 lines in 21 files

<details><summary>Files</summary>

- `client/src/features/chat/utils/chatFileUpload.js` (2)
- `client/src/shared/components/MemoryEditor.jsx` (1)
- `client/src/shared/hooks/useRunStream.js` (1)
- `client/src/api/integrationsAdminApi.js` (1)
- `client/src/api/utils/requestHandler.js` (1)
- `client/src/api/utils/fileErrors.js` (1)
- `client/src/features/skills/utils/skillErrors.js` (1)
- `client/src/features/admin/components/marketplace/MarketplaceItemDetail.jsx` (1)
- `client/src/features/admin/components/integrations/editors/useInstallationEditor.js` (1)
- `client/src/features/admin/components/integrations/IntegrationInstallForm.jsx` (1)
- `client/src/features/admin/components/integrations/migrationState.js` (1)
- `client/src/features/admin/components/ProjectPicker.jsx` (1)
- `client/src/features/documentPreview/utils/textPreview.js` (1)
- `client/src/features/projects/utils/projectErrors.js` (1)
- `client/src/features/voice/utils/pcmStreamPlayer.js` (1)
- `client/src/features/workflows/editor/panels/forms/useProjectNodeOptions.js` (1)
- `client/src/features/chat/mcpApps/McpAppView.jsx` (1)
- `client/src/features/chat/hooks/useAppChat.js` (1)
- `client/src/features/chat/utils/artifactFiles.js` (1)
- `client/src/features/settings/components/RequestableIntegrations.jsx` (1)
- `client/src/features/apps/components/AppLinkSharePanel.jsx` (1)

</details>

## Reads `details.code`

Pattern: `details\??\.code`

- `client/src`: 13 lines in 8 files

<details><summary>Files</summary>

- `client/src/features/chat/utils/chatFileUpload.js` (4)
- `client/src/features/skills/utils/skillErrors.js` (2)
- `client/src/features/prompts/utils/promptErrors.js` (2)
- `client/src/api/utils/fileErrors.js` (1)
- `client/src/api/endpoints/userSkills.js` (1)
- `client/src/features/admin/utils/projectAdmin.js` (1)
- `client/src/features/documentPreview/utils/textPreview.js` (1)
- `client/src/features/projects/utils/projectErrors.js` (1)

</details>

## Reads `details` as data (validation issues, `required`, `limit`, ...)

Pattern: `(data|response\??\.data|errorData)\??\.details\b`

- `client/src`: 15 lines in 11 files

<details><summary>Files</summary>

- `client/src/features/admin/components/integrations/editors/useInstallationEditor.js` (3)
- `client/src/features/admin/components/integrations/IntegrationInstallForm.jsx` (3)
- `client/src/api/utils/fileErrors.js` (1)
- `client/src/features/skills/utils/skillErrors.js` (1)
- `client/src/features/admin/components/integrations/migrationState.js` (1)
- `client/src/features/admin/utils/projectAdmin.js` (1)
- `client/src/features/admin/pages/AdminIntegrationBuilderPage.jsx` (1)
- `client/src/features/documentPreview/utils/textPreview.js` (1)
- `client/src/features/projects/utils/projectErrors.js` (1)
- `client/src/features/chat/utils/chatFileUpload.js` (1)
- `client/src/features/prompts/utils/promptErrors.js` (1)

</details>

## Reads `message` of an error body

Pattern: `(response\??\.data|errorData)\??\.message\b`

- `client/src`: 17 lines in 11 files

<details><summary>Files</summary>

- `client/src/api/utils/requestHandler.js` (3)
- `client/src/features/admin/pages/AgentRunDetailPage.jsx` (3)
- `client/src/features/workflows/pages/MyExecutionsTab.jsx` (3)
- `client/src/shared/components/MemoryEditor.jsx` (1)
- `client/src/api/adminApi.js` (1)
- `client/src/features/admin/pages/AdminUpdatesPage.jsx` (1)
- `client/src/features/admin/pages/AdminAgentsPage.jsx` (1)
- `client/src/features/admin/pages/AdminAgentEditPage.jsx` (1)
- `client/src/features/admin/pages/AdminAgentInboxesPage.jsx` (1)
- `client/src/features/admin/pages/AdminAgentMemoryPage.jsx` (1)
- `client/src/features/workflows/pages/WorkflowExecutionPage.jsx` (1)

</details>

## Reads `success` of an error body

Pattern: `success\s*===?\s*false|!\s*(data|result|response|res)\.success`

- `client/src`: 2 lines in 2 files

<details><summary>Files</summary>

- `client/src/features/admin/components/integrations/builder/BuilderActionsStep.jsx` (1)
- `client/src/features/admin/pages/AdminUpdatesPage.jsx` (1)

</details>
