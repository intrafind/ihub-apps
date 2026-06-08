# Table Download Feature

## Overview

The table download feature allows users to download tables embedded in chat responses as Excel, CSV, or JSON files. This feature is automatically available for all tables rendered in markdown content.

## Implementation

### Architecture

The feature follows the existing pattern for code block interactions:

1. **`useTableInteractions.js`** - React hook that handles table download interactions
2. **`marked.config.js`** - Custom table renderer that wraps tables with download buttons
3. **`MarkdownRenderer.jsx`** - Integrates the table interactions hook

### How It Works

1. When markdown is parsed, tables are wrapped in a container with download buttons
2. The `useTableInteractions` hook listens for click events on table download buttons
3. When a button is clicked, the table data is extracted and converted to the requested format
4. The file is automatically downloaded with a timestamped filename

### Supported Formats

- **Excel (.xlsx)**: Uses the `xlsx` library to create Excel workbooks
- **CSV (.csv)**: Standard comma-separated values format with proper escaping
- **JSON (.json)**: First row is used as headers, data rows are converted to objects

### Table Data Extraction

Tables are extracted by:
1. Finding all `<tr>` elements in the table
2. Extracting text content from `<th>` and `<td>` cells
3. Preserving row and column structure

### File Naming

Downloaded files are named with the format: `table-{timestamp}.{extension}`
- Timestamp format: `YYYY-MM-DDTHH-mm-ss`
- Extensions: `.xlsx`, `.csv`, `.json`

## Usage

Tables in markdown are automatically enhanced with download buttons:

```markdown
| Name | Age | City |
|------|-----|------|
| Alice | 30 | NYC |
| Bob | 25 | LA |
```

Will render with three download buttons below the table for Excel, CSV, and JSON formats.

## User Experience

- Download buttons appear in a toolbar below each table
- Buttons show format labels (Excel, CSV, JSON) on desktop
- Visual feedback is provided when download succeeds/fails
- Buttons are temporarily disabled during download operation

## Internationalization

All UI text supports internationalization through the i18n system:
- `common.table` - "Table" label
- `common.excel` - "Excel" button label
- `common.csv` - "CSV" button label
- `common.json` - "JSON" button label
- `common.downloadTableExcel` - Excel download tooltip
- `common.downloadTableCSV` - CSV download tooltip
- `common.downloadTableJSON` - JSON download tooltip

Currently supported languages:
- English (en)
- German (de)

## Technical Details

### Dependencies

- **xlsx** (v0.18.5): Already included in the project for Excel file generation
- No additional dependencies required

### Browser Compatibility

- Uses standard DOM APIs and Blob/URL creation
- Compatible with all modern browsers
- No special permissions required

### Performance

- Table extraction is performed on-demand (when download button is clicked)
- No impact on initial page render performance
- Memory efficient - files are generated and downloaded immediately

## Future Enhancements

Potential improvements for future iterations:
1. Support for more export formats (PDF, Markdown, HTML)
2. Configurable column selection before export
3. Preserve table styling in Excel exports
4. Support for merged cells and complex table structures
5. Bulk download of multiple tables at once
