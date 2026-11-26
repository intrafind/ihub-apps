---
description: "Convert PDFs and images into searchable Markdown with the OCR tool."
audience: admin
type: how-to
adminPage: /admin/features
---

# OCR

The OCR (Optical Character Recognition) feature converts PDF documents and images into structured, searchable markdown text. It is part of the **Tools Service**, a preview feature that must be enabled before use.

> [!TIP]
> To read images and scanned PDFs **when they are added** to a project or a chat, without a separate
> OCR job, set up text recognition in **Admin → Chat history → Uploaded files → Text
> recognition**. See [Projects → Images and scanned PDFs](projects.md#images-and-scanned-pdfs),
> [Chat files → Text recognition in chats](chat-files.md#text-recognition-in-chats) and
> [OCR engines](#ocr-engines) below. With a model as the engine it uses the same page rendering and
> prompt as this tool. Which pages of a PDF with text are read besides the scanned ones is a setting
> (**Pages of PDFs with text**: only pages without text, smart (also pages with large pictures or
> drawings), or all).

## OCR engines

Text recognition at upload reads with one engine for the whole installation, chosen under **Admin →
Chat history → Uploaded files → Text recognition → Engine** (`platform.ocr.engine`):

| Engine | What reads the pages | Set up |
|---|---|---|
| **A model that reads images** (`model`, the default) | a vision-capable model (`platform.ocr.modelId`), with the prompt of this tool | pick the model next to the engine |
| **An OCR integration** (its installation id) | the service the integration calls; the pages do not go to a model provider | install it under **Admin → Integrations → Text recognition**, then pick it as the engine |

iHub ships one OCR integration, the **iFinder OCR service** (`com.intrafind/ifinder-ocr`, installed
as `ifinder-ocr`): the OCR service of iFinder (`if-ocr`, Tesseract).

- **Service URL** (`serviceUrl`): the service with its API path, e.g. `http://if-ocr:9618/ocr-api`.
  A URL without a path gets `/ocr-api`. The address passes the SSRF check (company-internal
  addresses pass; `localhost` and link-local addresses need `ssrf.allowedHosts`), and a service with
  a private CA needs its host on `ssl.domainWhitelist`.
- **Authorization** (`authorizationRef`, optional): the service accepts every request in its default
  setup. For one set up for JWT or OAuth2, a credential of type secret, sent as a `Bearer` token.
- **Timeout per page** (`timeoutMs`, advanced, 120 s): the service recognizes two pages at a time
  and queues the rest.
- **Test connection** checks the address and sends a small blank image.
- iHub sends it one image at a time: an uploaded image, or a scanned PDF page rendered as PNG. It
  reads PNG, JPEG, GIF, BMP and TIFF and declares so; while it is the engine, a WebP image is not
  accepted for recognition (projects refuse it, chats send it to the model as a picture).
- The recognition languages are set on the service (`intrafind.ocr.engine.tesseract.languages`,
  German and English by default), not in iHub.

An OCR integration is never a tool for a model and no app binds it; its groups do not limit it
either, since it reads for every user once it is the engine. To connect another OCR service, write
an integration of `"type": "ocr"` (see
[Building an Integration → OCR engines](integration-development.md#ocr-engines)).

## Enabling OCR

OCR is disabled by default. Enable it in **Admin → Features → Tools Service** (preview category).

Once enabled, the OCR page is available at `/ocr` in the navigation. Starting an OCR job needs a signed-in user; with anonymous access, visitors who are not signed in cannot start one.

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

> [!NOTE]
> Full VLM and Smart modes require a vision-capable model. Text Only mode works without any AI model.

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

Requests without a signed-in user (including anonymous visitors) are answered with `401`.

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
