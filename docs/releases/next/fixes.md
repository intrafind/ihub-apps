# Fixes — Unreleased

## PDF Exports Download a Real PDF File

Chat export as PDF often produced a blank page, most visibly in the Outlook add-in and the browser
extension, and always went through the browser's print dialog. Chat exports, single-message
downloads, workflow result downloads and agent artifact downloads now render the PDF on the server
and download it directly.

- The export dialog's templates (Default, Professional, Minimal) and watermark settings apply to
  the file.
- The dialog now starts from the platform's PDF defaults (`pdfExport.defaultTemplate` and
  `pdfExport.watermark`).

## Skills Only Load in Apps That Offer Them

The model, or a slash command, could load any installed skill by name, including one the app does
not list or the user's groups do not grant. A skill is now loaded only when the app lists it and
the user may use it. The same rule already decided which skills a chat lists to the model.
