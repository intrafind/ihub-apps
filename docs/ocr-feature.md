# OCR Feature

The OCR (Optical Character Recognition) feature converts PDF documents and images into structured, searchable markdown text. It is part of the **Tools Service**, a preview feature that must be enabled before use.

## Enabling OCR

OCR is disabled by default. Enable it in **Admin → Features → Tools Service** (preview category).

Once enabled, the OCR page is available at `/ocr` in the navigation.

## Supported File Types

| Format | MIME Type         |
|--------|------------------|
| PDF    | `application/pdf` |
| JPEG   | `image/jpeg`      |
| PNG    | `image/png`       |
| TIFF   | `image/tiff`      |
| WebP   | `image/webp`      |

**Limits:**
- Up to **20 files** per request
- Up to **200 MB** per file

## OCR Modes

Choose the mode that matches your quality and cost requirements:

| Mode        | How it works                                                              | Best for                           |
|-------------|--------------------------------------------------------------------------|------------------------------------|
| **Full VLM**    | Every page is analyzed by the AI vision model                            | Scanned documents, handwriting, complex layouts |
| **Smart**       | Pages with enough embedded text are extracted directly; only scanned pages go through AI | Mixed documents (reduces cost) |
| **Text Only**   | Extracts embedded text from PDFs — no AI calls                           | Digital-native PDFs (fastest, free) |

> **Note:** Full VLM and Smart modes require a vision-capable model. Text Only mode works without any AI model.

## Using the OCR Page

1. Navigate to **OCR** in the application menu.
2. Drag and drop files or click to browse (PDF, JPEG, PNG, TIFF, WebP).
3. Select an OCR mode.
4. Optionally choose a specific AI model.
5. Optionally provide a custom extraction prompt (max 2,000 characters).
6. Click **Process** to start.

Each uploaded file becomes a separate job. A progress bar appears for each active job, updated in real time.

When a job completes, you can download the extracted markdown directly from the job card.

## Job Management

All OCR jobs are accessible on the **Jobs** page (`/jobs`). From there you can:

- Filter jobs by status (`queued`, `processing`, `completed`, `error`, `cancelled`)
- Download completed results
- Cancel running jobs

Admins see all users' jobs. Regular users see only their own.

## API Reference

### Start an OCR Job

```
POST /api/tools-service/ocr/process
Content-Type: multipart/form-data
Authorization: Bearer <token>
```

**Form fields:**

| Field       | Type                              | Default  | Description                                    |
|-------------|-----------------------------------|----------|------------------------------------------------|
| `files`     | File[] (required)                 | —        | One or more PDF or image files                 |
| `ocrMode`   | `full` \| `smart` \| `text-only`  | `full`   | Processing mode                                |
| `modelId`   | string (optional)                 | —        | AI model ID to use (overrides platform default)|
| `prompt`    | string (optional, max 2000 chars) | —        | Custom extraction prompt                       |
| `debugMode` | `true` \| `false` (optional)      | `false`  | Include extra debug output in results          |

**Response:** Returns an array of job objects, one per file.

```json
[
  {
    "jobId": "abc123",
    "status": "queued",
    "fileName": "report.pdf"
  }
]
```

### Stream Job Progress

```
GET /api/tools-service/jobs/:jobId/progress
Accept: text/event-stream
Authorization: Bearer <token>
```

Server-Sent Events stream. Each event contains:

```json
{
  "status": "processing",
  "toolType": "ocr",
  "progress": { "current": 4, "total": 12 },
  "error": null,
  "model": "gpt-4o"
}
```

The stream closes automatically when the job reaches `completed`, `error`, or `cancelled`.

### List Jobs

```
GET /api/tools-service/jobs
Authorization: Bearer <token>
```

Optional query parameters:

| Parameter  | Description                                            |
|------------|--------------------------------------------------------|
| `status`   | Filter by job status (e.g. `completed`, `processing`)  |
| `toolType` | Filter by tool (e.g. `ocr`)                            |

## Technical Notes

- **Server-side rendering**: PDFs are rendered on the server at ~1600 px on the long edge for optimal OCR quality. This avoids large base64 payloads from the client.
- **Concurrent processing**: Up to 5 VLM API calls run in parallel per job to balance speed and rate-limit safety.
- **Smart detection**: Pages with fewer than 50 extracted characters are considered scanned and sent to the vision model in Smart mode.
- **Output format**: Results are structured markdown with semantic annotations (headings, tables with summaries, chart/diagram descriptions, page-level metadata comments). The format is optimized for downstream RAG and full-text indexing.
