TITLE: Let the model search, read and save files in connected cloud storage (OneDrive/SharePoint, Google Drive, Nextcloud) — not only through the file picker
LABELS: enhancement, backend, tools
---
Part of #EPIC. Builds on #FRAMEWORK.

## Summary

Users can already connect OneDrive/SharePoint/Teams, Google Drive and Nextcloud, but only to **pick** files by hand in the upload dialog. Expose the same connections as model-callable tools, so an app can:

- **search** the user's storage ("find the latest version of the framework contract with Contoso");
- **read** a found file;
- after confirmation, **save** a generated document back ("save this report to my OneDrive under Reports").

## Current state

- **The services can already search and download.**
  - `Office365Service`: `listPersonalDrives`, `listSharePointDrives`, `listTeamsDrives`, `listItems`, `searchItems`, `downloadFile`.
  - `GoogleDriveService`: `listMyDriveFiles`, `listSharedDrives`, `searchFiles`, `downloadFile`, with export of Google Docs/Sheets/Slides to PDF/XLSX.
  - `NextcloudService`: `listItems`, `searchItems`, `downloadFile`.
- **These are only reachable through the picker routes** (`server/routes/integrations/office365.js`, `googledrive.js`, `nextcloud.js`). There are no tools.
- **Text extraction runs in the browser.** The download route streams the raw file to the browser, and text extraction happens client-side (`client/src/features/upload/utils/fileProcessing.js`, using `mammoth` and `pdfjs-dist`). The server only has `pdfjs-dist` (used by `webContentExtractor`). A tool running on the server therefore needs a **server-side extractor** for PDF, DOCX, PPTX and XLSX.
- **Scopes are read-only today:** `Files.Read(.All)` and `drive.readonly`.
- **#410** asks for SharePoint "as a source handler and tool … in the context of the user". This issue covers the tool part for all three providers. The knowledge-source part stays in #410.

## Proposal

### One contract, three providers

These are the connector `files` capability from #FRAMEWORK.

| Tool | Effect | Returns |
| --- | --- | --- |
| `<provider>_searchFiles` | read | `[{ id, title, path, mimeType, size, modifiedAt, modifiedBy, webUrl, provider, driveId }]` |
| `<provider>_listFolder` | read | folder contents, for browsing ("what's in /Projects/X?") |
| `<provider>_readFile` | read | extracted text (markdown where possible), page/section markers, truncation notice; the file is also attached to the chat as a document so citations work |
| `<provider>_saveFile` | write | uploads a generated artifact or chat export (DOCX/PDF/MD) to a chosen folder; needs write scopes |

Providers: `onedrive` (OneDrive, SharePoint and Teams libraries), `gdrive`, `nextcloud`.

An optional `cloud_searchFiles` tool fans out over all of the user's connected providers and merges the results.

### Provider notes

- **Microsoft 365:**
  - Graph `driveItem` search per drive.
  - Microsoft Search (`/search/query`, `entityTypes: ["driveItem"]`) searches across all SharePoint sites the user can access. That is closer to what users expect than search per drive.
  - Writing needs `Files.ReadWrite(.All)`.
- **Google Drive:** Drive `files.list` with a `q` query. Google-native files are exported to text-friendly formats, for example Docs as markdown or plain text rather than PDF. Writing needs `drive.file`.
- **Nextcloud:** WebDAV search (`SEARCH` on `/remote.php/dav/`) and the existing download path. Writing uses WebDAV `PUT`.

### Server-side extraction

- Add a shared server-side document-to-text service for PDF, DOCX, PPTX, XLSX/CSV and TXT/MD/HTML. The Outlook Mail attachment tool and the Confluence attachment tool use it too.
- It has size and page caps and returns structured "page N" markers for citations.
- OCR for scanned PDFs can reuse the existing OCR processor as an optional step.

### Permissions

- **Everything runs with the user's delegated token.** The model can only find what the user can open.
- **Admin controls per provider:** enable tools, and enable save (write). Write scopes are requested only when save is enabled.

## Acceptance criteria

- [ ] Search, list and read tools for OneDrive/SharePoint/Teams, Google Drive and Nextcloud on top of the existing connections.
- [ ] Microsoft 365 search spans all sites the user can access (Microsoft Search API).
- [ ] Server-side text extraction for PDF, DOCX, PPTX, XLSX and text formats with caps; read files are attached to the chat for citation.
- [ ] Save-to-storage tool with folder choice and confirmation; write scopes only when enabled.
- [ ] Optional cross-provider search.
- [ ] Tests with mocked provider APIs and fixture documents; docs updated (`docs/office365-integration.md`, `docs/google-drive-integration.md`, `docs/nextcloud-integration.md`); changelog entry.

## Open questions

1. Should the server-side extractor replace client-side parsing for uploads too, so both paths give the same result, or stay separate?
2. Should "read file" count against the same upload size limits as manual uploads?

## Related

- #410: SharePoint integration (source handler part remains there).
- #FRAMEWORK: the `files` capability and scope upgrade.
- Outlook Mail tools and Confluence in #EPIC (they share the extractor).

---
_Generated by [Claude Code](https://claude.ai/code)_
