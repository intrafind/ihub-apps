# Error Responses

Every error response of the API has one shape, except the OAuth endpoints.

```json
{
  "error": "Scheduled task not found",
  "code": "NOT_FOUND",
  "details": { "taskId": "t1" }
}
```

| Field     | Always | Meaning                                                                                                                                 |
| --------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `code`    | yes    | A code from the registry in `shared/apiErrors.js`. The client picks its message with the i18n key `apiErrors.<code>` (`shared/i18n`).    |
| `details` | no     | A plain object. Its members are the interpolation parameters of that message. It never holds `code`.                                    |
| `error`   | yes    | English fallback text for callers without i18n. A 4xx carries the message that was thrown; a 5xx a fixed text (the real one is logged). |

Validation failures use `code: "VALIDATION_FAILED"` and `details.issues`, a list of `{ path, code, message }`.
A rate limit sets the `Retry-After` header and `details.retryAfterMs`.

OAuth endpoints (`/api/oauth/*`, `/.well-known/*`) keep the RFC 6749 shape, `{ "error", "error_description" }`.

## For developers

Throw, do not answer. A route handler needs no `try`/`catch` for errors: Express 5 hands a thrown error or a rejected promise to the
global error middleware (`server/middleware/errorHandler.js`), which maps it with `server/utils/errorResponse.js`:

| Thrown                                                      | Status and code                                                                                          |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `ServiceError(code, message, { status?, details? })`        | the given status, else the code's default                                                                |
| `StorageError` and subclasses                               | `storageHttpStatus()`; the storage code (`ETAG_MISMATCH`, ...) or `STORAGE_ERROR`                        |
| `LLMError`                                                  | by its code (`RATE_LIMITED` 429, `TIMEOUT` 504, `AUTH_FAILED` 502, ...); the provider's text is not sent |
| `ZodError`                                                  | 400 `VALIDATION_FAILED`                                                                                  |
| Errors of Express middleware (body too large, bad JSON, ...) | their status, with the generic code of that status                                                       |
| anything else                                               | 500 `INTERNAL_ERROR`                                                                                     |

A new code goes into `shared/apiErrors.js` and into `apiErrors` of both `shared/i18n/en.json` and `de.json`; a test fails otherwise.
