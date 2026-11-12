# API Guidelines

The rules every HTTP endpoint of iHub Apps follows. They exist because the API grew endpoint by endpoint and
looks different in every corner: three success envelopes, five pagination styles, verbs in URLs, hand-rolled
error bodies. A client developer should be able to guess how an endpoint behaves from the one before it.

They are modelled on the [Zalando RESTful API Guidelines](https://opensource.zalando.com/restful-api-guidelines/)
and [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html), with the deviations listed in
[Deviations from Zalando](#deviations-from-zalando).

**Scope:** the `server/` API of this repository. The OpenAI-compatible endpoints (`/v1/*`) and the OAuth
endpoints (`/api/oauth/*`, `/.well-known/*`) follow the external specification they implement, not this document.

**Rule of thumb:** a new endpoint follows these rules. An endpoint you touch is brought in line if that is cheap
and does not break a caller outside this repository. Nobody rewrites the API in one go.

## 1. Resources and URLs

- **Plural nouns, kebab-case:** `/api/scheduled-tasks/{taskId}/runs`. No verbs, no trailing slash, no empty segments.
- **Sub-resources by path** for containment, at most two levels deep: `/conversations/{conversationId}/items/{itemId}`.
  Deeper than that, address the inner resource directly.
- **Path and query parameters are camelCase:** `providerId`, `appId`, `taskId`.
- **IDs are opaque strings.** The client never builds or parses them. A client never supplies the ID of a resource
  it creates with `POST`; the server generates it.
- **Filtering, sorting and search are query parameters** with AND semantics: `?status=failed&appId=chat`.
  Conventional names: `q` (free text), `sort` (`field` or `-field` for descending), `fields` (partial response).
- **`GET` never has a body.**

### Actions: `_action` segments

An operation that is not create, read, update or delete is an **action**. Actions are a path segment prefixed
with an underscore, so they can never collide with an ID, and every client can tell at a glance that it is not a
resource:

```
POST /api/scheduled-tasks/{taskId}/_duplicate
POST /api/scheduled-tasks/{taskId}/runs/{runId}/_cancel
POST /api/scheduled-tasks/_preview
POST /api/api-keys/{keyId}/_rotate
GET  /api/scheduled-tasks/_notifications          (a virtual collection, same prefix)
```

- Actions are `POST` (state change) or `GET` (read-only virtual collection, such as `_notifications`).
- Use the prefix only when no resource models the operation. Prefer `POST /scheduled-tasks/{id}/runs` (create a
  run) to `/_run`; prefer `DELETE` with a filter to `POST /runs/delete`.
- Name the action with a verb in the imperative: `_cancel`, `_rotate`, `_disconnect`, `_duplicate`.
- An action returns what its result is: the changed resource (`200`), a new resource (`201` + `Location`), or
  `202` with a job resource when it runs asynchronously. Never `{ success: true }`.
- A **test** (`POST …/_test`: an LDAP bind, a registry fetch, an endpoint probe) answers `200` with its report when
  the test ran, because that it failed is its result; the body says so (`success`, `message`, steps). An action that
  could not run at all (nothing to do, a refused request) is an error, not a report: `409 CONFLICT`, `400`, `502`.
- `scheduledTasks.js` already uses `_preview`, `_notifications` and `_apps/{appId}/tools`; that is the model.
  No endpoint uses a bare verb any more (`/run`, `/duplicate`, `/cancel`, `/rotate`, `/disconnect` became
  `/_run`, `/_duplicate`, `/_cancel`, `/_rotate`, `/_disconnect`); `scripts/check-api-guidelines.js` keeps it so.

## 2. Methods and status codes

| Operation                  | Method   | Success                                                               |
| -------------------------- | -------- | --------------------------------------------------------------------- |
| Read one / list            | `GET`    | `200` with the resource or the list                                   |
| Create                     | `POST`   | `201`, the created resource in the body, `Location` header            |
| Replace                    | `PUT`    | `200` with the resource                                               |
| Partial update             | `PATCH`  | `200` with the resource; body is a JSON Merge Patch (RFC 7396)        |
| Delete                     | `DELETE` | `204`, no body                                                        |
| Long-running work          | `POST`   | `202` with a job resource and its URL in `Location`                   |
| Conditional `GET`          | `GET`    | `304` when `If-None-Match` matches                                    |

- **The status code carries success or failure.** No `{ success: true }`, no `{ message: "… successfully" }`.
  The body of a success is the resource (or the list), nothing wrapped around it.
- **A top-level JSON value is always an object** (never a bare array), so a field can be added later without a
  breaking change. Lists are `{ "items": [...] }` (see [Lists](#4-lists)).
- `PUT` and `DELETE` are idempotent; a repeated `DELETE` of a missing resource is `404`, not a different success.
- **Use the most specific code.** The ones we use:

| Code  | Use                                                                                      |
| ----- | ---------------------------------------------------------------------------------------- |
| `400` | Malformed request **and** validation failure (not `422`)                                  |
| `401` | Not authenticated                                                                         |
| `403` | Authenticated, not allowed. For a resource the caller may not even know exists, use `404` |
| `404` | No such resource                                                                          |
| `409` | State conflict, including a failed optimistic-lock check (`ETAG_MISMATCH`)                |
| `413` / `415` | Body too large / unsupported media type                                           |
| `429` | Rate limit, with `Retry-After`                                                            |
| `502` / `503` / `504` | Upstream failed / unavailable (`Retry-After` if known) / timed out              |
| `500` | A bug. Never a deliberate answer                                                          |

Do not redirect from API endpoints (`3xx` other than `304`).

## 3. Errors

Every `4xx` and `5xx` response is `application/problem+json` as defined by
[RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html), plus our `code`.

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

| Member    | Always | Meaning                                                                                                                              |
| --------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `type`    | yes    | `urn:ihub:problem:<code>`. Stable identifier of the problem type; not dereferenceable.                                                |
| `title`   | yes    | English text of the code. The same for every occurrence of the code.                                                                  |
| `status`  | yes    | The HTTP status, repeated.                                                                                                            |
| `detail`  | yes    | What went wrong in this occurrence, in English, written to be shown. Never parsed by a client.                                        |
| `code`    | yes    | The registry code of `shared/apiErrors.js`. The client picks its message with the i18n key `apiErrors.<code>`.                        |
| `details` | no     | A plain object: the interpolation parameters of the client's message. It never holds `code`.                                          |
| `errors`  | no     | Validation failures only: `[{ "pointer": "/prompt/en", "code": "REQUIRED", "message": "…" }]`, `pointer` being an RFC 6901 JSON Pointer. |

- **A client branches on `code`**, never on `status` alone and never on text.
- **Validation failure:** `400`, `code: "VALIDATION_FAILED"`, one entry in `errors` per problem, all of them at once.
- **Rate limit:** `429`, `Retry-After` header (seconds), and `details.retryAfterMs`.
- **No internals in a response:** no stack traces, file paths, URLs of internal hosts, SQL, credentials. The
  [5xx message filter](error-responses.md#what-a-5xx-message-may-contain) stays: an unsafe message is replaced by the
  title of the code and the real one is only logged.
- **Throw, do not answer.** A handler throws a `ServiceError(code, message, { status?, details? })` and the global
  error middleware shapes the response. A handler never writes an error body itself, with `res.status(…).json({ error })`
  or any other form. This is also what makes the shape the same everywhere. Where throwing is not possible (a
  surrounding `try` would catch it and answer twice), `sendErrorResponse(res, status, message, { code?, details? })`
  writes the same response in place; it goes through the same mapper.
- **A new code** goes into `shared/apiErrors.js` and into `apiErrors` of `shared/i18n/en.json` and `de.json`.
  Codes are `UPPER_SNAKE`; never `kebab-case` or ad hoc strings.
- The OAuth endpoints and bearer-token errors keep `{ "error", "error_description" }` of RFC 6749 / 6750, the
  OpenAI-compatible endpoints keep the OpenAI error object. The codes of the voice WebSocket are protocol
  codes and stay outside the registry; the read-aloud routes use registry codes.

## 4. Lists

```
GET /api/conversations?limit=50&cursor=eyJ…&status=active
```

```json
{ "items": [ … ], "nextCursor": "eyJ…" }
```

- **Cursor pagination** with the query parameters `limit` and `cursor`. The cursor is opaque; a client only
  passes back what `nextCursor` gave it. `nextCursor` is `null` on the last page.
- `limit` has a documented default and maximum; a larger value is capped, not rejected.
- **No** `page`, `pageSize`, `offset`, `after` or `per_page`.
- `total` is optional and only offered where it is cheap; a client must not need it to page.
- Small, bounded collections that are never paged (the list of models, of groups, of apps) still answer
  `{ "items": [...] }`, so they can grow a cursor later without breaking anyone.
- `sort` accepts `field` or `-field`; the default order is documented and stable.

## 5. Payloads

- **JSON, UTF-8, `camelCase` property names.** Same for query parameters and path parameters.
- **Dates and times:** RFC 3339 in UTC, `2026-11-06T09:30:00Z`, as strings. Durations are in the property name's
  unit, written in the name: `timeoutMs`, `retryAfterMs`.
- **`null` and absent mean the same** on output; omit a member that has no value. The exception is `PATCH`
  (JSON Merge Patch), where `null` removes the member.
- **No `null` booleans.** A tri-state is an enum.
- **Enums are strings** (`"running"`, not `2`), and a client must tolerate a value it does not know.
- **Be liberal in what you read:** a client ignores members it does not know. A server rejects unknown members only
  where a typo would silently do the wrong thing (a config file), and then says so with `VALIDATION_FAILED`.
- **Binary data** is a separate endpoint with its own media type, not base64 inside JSON, except for small
  inline images.

## 6. Headers

- **Names** are standard headers where one exists. Custom headers are `kebab-case` and documented.
- **Optimistic locking:** resources that are edited concurrently return an `ETag`; an update sends `If-Match`. A
  mismatch is `409` `ETAG_MISMATCH` (see [deviations](#deviations-from-zalando)).
- **`Idempotency-Key`** on a `POST` that must not run twice on a retry (it creates something that costs money or
  sends something to a person). The server remembers the key for 24 hours; the same key with a different body is `400`.
- **`Retry-After`** on `429` and on `503` when the time is known.
- **`Deprecation` and `Sunset`** (RFC 9745 / RFC 8594) on an endpoint that is going away, see below.
- **`Location`** on `201` and `202`.

## 7. Compatibility, versioning and deprecation

- **Changes are additive:** a new endpoint, a new optional parameter, a new member in a response, a new enum value
  (clients tolerate it). Removing or renaming a member, making an optional one required, changing a type or the
  meaning of a status code is **breaking**.
- A breaking change to an endpoint that only our own client calls ships with that client in the same release, and
  needs no deprecation period. Ask before adding a compatibility shim (see `CLAUDE.md`, "Breaking Changes").
- **A changed body needs a changed `ETag`.** A route that sets its `ETag` from a config hash (`/api/apps`,
  `/api/models`, the admin lists, …) sends it through `responseEtag()` (`server/utils/etag.js`). Changing the shape
  of such a body means bumping `RESPONSE_SHAPE_REVISION` there: the config hash stays the same, so the browser
  would revalidate its cached old body, get `304` and keep serving it to the new client.
- A breaking change to an endpoint that has external callers (integrations, browser extension, Nextcloud app,
  Office add-in, API keys) is announced first: the old endpoint answers with `Deprecation` and `Sunset` headers and
  a link to the replacement, for at least one release, and the release changelog says so.
- **No version in the URL** of the internal API. A truly incompatible external contract gets a new path prefix
  (`/api/v2/…`) alongside the old one, as the OpenAI-compatible endpoints do with `/v1/`.

## 8. Security and visibility

- Every endpoint states its authentication requirement; unauthenticated is the exception and is written down.
- Authorization that **filters** a result (a user sees only their own items) is documented on the endpoint.
- Input validation, path-traversal and parameter rules: see the `api-security` skill and `server/utils/pathSecurity.js`.

## 9. Documenting and checking

- **The OpenAPI comment of the route is the contract** (`server/utils/apiDocSpecs.js` builds the document; `npm run build:api-docs` fails on a malformed block). A new or
  changed endpoint documents its request, its success body, and every error code it can answer with. Write it
  _before_ the handler.
- A test for a new endpoint asserts the status code, the body shape, and for an error `code` and
  `application/problem+json`.
- A review checks the [checklist](#checklist) below.

### Checked on every pull request

The **API guidelines** check (`.github/workflows/api-guidelines-check.yml`, `scripts/check-api-guidelines.js`)
runs on every pull request and is a required status check. It is a ratchet, like the accessibility check: it looks
only at lines the pull request adds or changes, so the existing backlog does not block anyone, and new code
meets the rules. It reports, as annotations on the diff:

| Rule                | Finds                                                                          |
| ------------------- | ------------------------------------------------------------------------------ |
| `hand-rolled-error` | `res.status(4xx/5xx).json({ error … })`: throw a `ServiceError` instead        |
| `success-envelope`  | `.json({ success … })`, `.json({ message: '… successfully' })`                  |
| `status-422`        | `res.status(422)`: validation is `400`                                          |
| `route-verb`        | a `POST`/`PUT`/`PATCH`/`DELETE` route that ends in a verb: use an `_action`     |
| `route-naming`      | a literal path segment that is not lower-case kebab-case                       |
| `pagination-param`  | `req.query.page`, `pageSize`, `offset`, `after`, `per_page`: use `limit`/`cursor` |
| `query-naming`      | a snake_case query parameter                                                    |

Endpoints that implement an external specification are exempt (OAuth, `/.well-known`, the OpenAI-compatible
`/v1` and `inference` routes, the MCP server). A line with a real reason to break a rule carries
`// api-guidelines-ignore: <reason>` on the same or the previous line; the reviewer judges the reason.
The check finds the mechanical violations; the [checklist](#checklist) still covers what a script cannot
(the right status code, a resource model, compatibility).

## Checklist

- [ ] Plural, kebab-case, verb-free path; actions use `_action`
- [ ] camelCase query, path and body names
- [ ] Right method and status: `201` + `Location`, `204` for delete, `400` for validation
- [ ] No `{ success }` / `{ message }` envelope; a top-level object
- [ ] Errors thrown as `ServiceError` with a registry code, never hand-written
- [ ] Lists are `{ items, nextCursor }` with `limit` / `cursor`
- [ ] OpenAPI comment with all success and error responses
- [ ] Test covers status, shape and error code
- [ ] Breaking change? Own client in the same release, or `Deprecation` / `Sunset` for external callers

## Deviations from Zalando

| Zalando                                  | Here                                              | Why                                                                                      |
| ---------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `snake_case` properties and parameters   | `camelCase`                                       | Everything in the server and the client is already camelCase; the JS ecosystem expects it |
| Verb-free URLs                           | `_action` segments for operations with no resource | A state transition (`_cancel`, `_rotate`) is not a CRUD operation; the prefix marks it    |
| Failed `If-Match` is `412`               | `409` `ETAG_MISMATCH`                             | Already shipped in the storage layer and the client                                       |
| `type` as a relative URI                 | `urn:ihub:problem:<code>`                         | Relative URIs break under a base path (subpath deployment)                                |
| API First with a separate OpenAPI file   | OpenAPI comment in the route file                 | The document is generated from the routes; one place to keep up to date                   |

## Where we are

- **Errors:** done. The mapper (`server/utils/errorResponse.js`) answers `application/problem+json` and the
  API guidelines check keeps new hand-written bodies out. The exceptions are the specifications that fix their
  own shape (OAuth and bearer tokens, the OpenAI-compatible endpoints).
- **Success bodies, verbs, pagination:** migrate when an endpoint is touched. The check fails a new
  `{ success }` envelope, a bare verb in a route and a `page` / `offset` parameter; a grep for
  `json({ success`, `json({ message:` and `/run`, `/duplicate`, `/cancel` finds the candidates.

## Checks that keep the API and its clients in step

| Check                                    | What it catches                                                                                                    | Run it                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| API guidelines (CI)                      | New lines that break the rules above                                                                               | `scripts/check-api-guidelines.js` (diff on stdin) |
| Client contract (`test-quick`)           | A client calls a route or method the server no longer registers                                                    | `scripts/check-client-api-contract.js`            |
| Removed routes (CI)                      | A route removed or renamed without a mention in `docs/releases/next`                                               | `scripts/check-route-changes.js --strict`         |
| Response shapes (CI)                     | A key renamed or moved in an answer. The shape of every readable `GET` route is committed in `tests/contract/response-shapes.json` | `npm run check:response-shapes`                   |
| Route crawl (CI, `tests/e2e`)            | A page that fails an API call, throws or logs an error; also on a path prefix (`npm run test:e2e:subpath`)        | `npm run test:e2e:crawl`                          |
| Upgrade check                            | The previous release's data no longer starts on this checkout                                                      | `scripts/check-upgrade.js`                        |

The response-shape check starts the server on seeded contents (`tests/config/e2e-contents.mjs`, plus a
record of each kind created by the check itself), requests the readable `GET` routes as the default admin and
compares keys and types, never values. When an answer changes on purpose, run
`node scripts/check-response-shapes.js --update`, read the diff of the snapshot, and check the clients that read
that answer: the snapshot shows the change, not whether the client follows it. It cannot see `POST`, `PUT` or
`DELETE` answers, routes whose data the seed does not have (the report lists the lists that answered empty), and
integrations that need a real credential.
