# Error Responses

Every error response of the API is `application/problem+json` (RFC 9457) with the same members,
except the OAuth endpoints, bearer-token errors and the OpenAI-compatible `/v1/*` endpoints, which
keep the formats of their specifications.

```json
{
  "type": "urn:ihub:problem:NOT_FOUND",
  "title": "The requested resource was not found.",
  "status": 404,
  "detail": "Scheduled task t1 not found",
  "code": "NOT_FOUND",
  "details": { "taskId": "t1" }
}
```

| Member    | Always | Meaning                                                                                                                                                                  |
| --------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `type`    | yes    | `urn:ihub:problem:<code>`: a stable identifier of the problem type, not an address to fetch.                                                                              |
| `title`   | yes    | The English text of the code, the same for every occurrence.                                                                                                              |
| `status`  | yes    | The HTTP status again.                                                                                                                                                    |
| `detail`  | yes    | What went wrong in this occurrence, in English, for callers without i18n. A 4xx carries the message that was thrown. A 5xx carries it too when it is safe to show, else the `title`; the real message is always logged. Never parse it. |
| `code`    | yes    | A code from the registry in `shared/apiErrors.js`. The client picks its message with the i18n key `apiErrors.<code>` (`shared/i18n`). **Branch on this.**                  |
| `details` | no     | A plain object. Its members are the interpolation parameters of the client's message, or what the caller can act on (`retryAfterMs`, `currentVersion`, `linkedModels`). It never holds `code`. |
| `errors`  | no     | Validation only: `[{ pointer, code, message }]`, `pointer` being an RFC 6901 JSON Pointer to the offending member (`/schedule/cron`).                                       |

Validation failures use `400` with `code: "VALIDATION_FAILED"` and one entry in `errors` per problem.
A rate limit sets the `Retry-After` header and `details.retryAfterMs`. The media type is
`application/problem+json`; a client that checks it must not compare for `application/json` only.

OAuth endpoints (`/api/oauth/*`, `/.well-known/*`) and bearer-token errors keep the RFC 6749 / 6750
shape, `{ "error", "error_description" }`. The OpenAI-compatible endpoints keep the OpenAI error
object. The voice routes keep their kebab-case protocol codes (`invalid-voice`, `not-permitted`),
which are shared with the voice WebSocket and are not in the registry.

## For developers

Throw, do not answer. A route handler needs no `try`/`catch` for errors: Express 5 hands a thrown error or a rejected promise to the
global error middleware (`server/middleware/errorHandler.js`), which maps it with `server/utils/errorResponse.js`:

| Thrown                                                      | Status and code                                                                                          |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `ServiceError(code, message, { status?, details? })`        | the given status, else the code's default; `details.issues` (a list of `{ path, code?, message }`) becomes `errors` |
| `StorageError` and subclasses                               | `storageHttpStatus()`; the storage code (`ETAG_MISMATCH`, ...) or `STORAGE_ERROR`                        |
| `LLMError`                                                  | by its code (`RATE_LIMITED` 429, `TIMEOUT` 504, `AUTH_FAILED` 502, ...); the provider's text is not sent |
| `ZodError`                                                  | 400 `VALIDATION_FAILED` with `errors`                                                                    |
| Errors of Express middleware (body too large, bad JSON, ...) | their status, with the generic code of that status                                                       |
| anything else                                               | 500 `INTERNAL_ERROR`                                                                                     |

A new code goes into `shared/apiErrors.js` and into `apiErrors` of both `shared/i18n/en.json` and `de.json`; a test fails otherwise.
A code the registry does not know (a protocol code of another subsystem) still answers, with the `title` of its status.

Where throwing is not possible, because a surrounding `try` would catch the error and answer a second time, write the
same response in place with `sendErrorResponse(res, status, message, { code?, details? })` from `server/utils/responseHelpers.js`.
`sendNotFound`, `sendBadRequest` and `sendInternalError` are shorthands of it. A code passed as `details.code` (the
older convention) is taken as the `code` of the response, and a list of problems passed as `details` becomes `errors`. It never writes `{ error }` itself: it
goes through the same mapper, so the body is identical.

### What a 5xx message may contain

A 5xx message is shown only if it is short (up to 200 characters), one line, and holds none of: a file path or file name, a URL, an IP address or host:port, a stack frame, an errno code (`ECONNREFUSED`), a credential word (`password`, `token`, `secret`, `api key`, `session`, ...), a long token-like string or SQL. Messages of runtime bugs (`TypeError` and kin), system errors and model providers are never shown. When a message is held back `detail` is the `title` (the fixed text of the code), and the log still tells an operator what happened. Write messages of `ServiceError`s with that in mind: say what failed, not where or with what.
