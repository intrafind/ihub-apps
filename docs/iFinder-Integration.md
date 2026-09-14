# iFinder Integration Documentation

This document provides comprehensive information about the iFinder document management system integration in iHub Apps.

## Overview

The iFinder integration allows iHub Apps to search, retrieve, and analyze documents from your iFinder document management system. Users can interact with documents using natural language through AI assistants that automatically search for relevant content, extract document metadata, fetch full document text, and provide insights.

## Features

### Core Functionality

- **🔍 Document Search**: Search for documents using natural language queries
- **📄 Content Retrieval**: Fetch full document content for analysis and summarization
- **ℹ️ Metadata Access**: Get detailed document metadata (author, creation date, file type, etc.)
- **💾 Document Download**: Save documents locally or get download information
- **🖍️ Passage Highlighting**: Jump from a cited passage to its position in the source document and
  highlight it in the in-app PDF preview
- **🔐 Secure Authentication**: User-based JWT authentication for all operations
- **👤 User Context**: All operations respect the authenticated user's permissions

### AI-Powered Capabilities

- **Conversational Interface**: Ask questions about documents in natural language
- **Content Analysis**: Summarize, analyze, or extract information from documents
- **Smart Search**: Find documents based on content, metadata, or contextual queries
- **Multi-step Operations**: Chain operations (search → analyze → summarize)
- **Context Awareness**: Remember documents discussed in the conversation

## Configuration

### 1. Environment Variables

Set these environment variables for iFinder integration:

```bash
# Required: iFinder API Configuration
IFINDER_API_URL=https://your-ifinder-instance.com
IFINDER_SEARCH_PROFILE=your-default-search-profile
IFINDER_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDKrCFR...
-----END PRIVATE KEY-----"

# Optional: Advanced Configuration
IFINDER_TIMEOUT=30000
IFINDER_DOWNLOAD_DIR=/tmp/ifinder-downloads
```

**Important Notes:**

- **IFINDER_PRIVATE_KEY**: Must be in PEM format for RS256 JWT signing
- **Line breaks**: Use actual newlines or `\n` escapes - the system will convert them automatically
- **Search Profile**: This is the default profile ID used for all searches

### 2. Platform Configuration

Alternatively, configure iFinder in your `platform.json`:

```json
{
  "iFinder": {
    "baseUrl": "https://your-ifinder-instance.com",
    "defaultSearchProfile": "your-default-search-profile",
    "privateKey": "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDKrCFR...\n-----END PRIVATE KEY-----",
    "endpoints": {
      "search": "/public-api/retrieval/api/v1/search-profiles/{profileId}/_search",
      "document": "/public-api/retrieval/api/v1/search-profiles/{profileId}/docs/{docId}"
    },
    "timeout": 30000,
    "downloadDir": "/tmp/ifinder-downloads",
    "algorithm": "RS256",
    "issuer": "ihub-apps",
    "audience": "ifinder-api",
    "defaultScope": "fa_index_read",
    "tokenExpirationSeconds": 3600
  }
}
```

### 3. JWT Configuration

> **Recommended: keyless authentication.** Instead of generating and exchanging
> an RSA key pair, enable `iFinder.useOidcKeyPair`. iHub then signs the iFinder
> JWT with its built-in OIDC signing key and iFinder verifies it by fetching the
> public key from iHub's JWKS endpoint — no `privateKey`/`IFINDER_PRIVATE_KEY`
> and no manual key upload into iFinder. See
> [iFinder Keyless (OIDC/OAuth) JWT Integration](ifinder-oidc-jwt.md). The manual
> key configuration described below is the legacy alternative.

The iFinder integration uses JWT tokens for authentication with the following structure:

```json
{
  "sub": "user.email@example.com",
  "name": "User Name",
  "admin": true/false,
  "iat": 1516239022,
  "scope": "fa_index_read"
}
```

**Key Requirements:**

- **Algorithm**: RS256 (RSA with SHA-256)
- **Private Key**: Must be in PEM format
- **Scope**: `fa_index_read` for document access
- **User Context**: Tokens are generated per authenticated user

### 4. User Authentication

Users must be authenticated to use iFinder features. The system supports:

- **Anonymous Users**: Cannot access iFinder (throws authentication error)
- **Authenticated Users**: Can search and access documents based on iFinder permissions
- **Admin Users**: Automatically marked as admin in JWT tokens

## Available Tools

The iFinder integration exposes these functions under the `iFinder.` namespace
(`iFinder_<function>` when called over the MCP gateway):

| Function | Purpose |
| --- | --- |
| `search` | Find documents with a Lucene query, filters, facets, sorting and paging |
| `getContent` | Fetch a document's extracted text |
| `getMetadata` | Fetch a document's metadata without its text |
| `download` | Download or save a document's binary |
| `getFields` | The index field catalog — which fields exist and which need `.keyword` |
| `getFacetValues` | Enumerate the values of one facet |
| `listProfiles` | The search profiles this user can reach |
| `discover` | One probe returning totals, top facets, sample titles and the field catalog |

The last four are the **discovery** surface; see
[Discovering what is searchable](#discovering-what-is-searchable).

### iFinder.search

Search for documents using natural language queries.

**Parameters:**

- `query` (required): Lucene query string — `AND`/`OR`/`NOT`, quoted phrases,
  `field:value`, wildcards and ranges. `*` matches everything.
- `maxResults` (optional): Maximum results to return (default: 10, max: 100)
- `from` (optional): Offset of the first hit, for paging past the 100-hit cap
- `filter` (optional): Array of Lucene query strings ANDed with the query but
  excluded from relevance ranking — the right place for narrowing criteria
- `searchProfile` (optional): Specific search profile ID
- `returnFields` (optional): Array of specific fields to return (`*` for all)
- `returnFacets` (optional): Array of facet fields to aggregate alongside the hits
- `sort` (optional): Array of `field:asc` / `field:desc` criteria

**Field names and `.keyword`.** Every text field is indexed twice: the plain
name (`creators`) is analyzed for relevance-ranked matching, and the `.keyword`
name (`creators.keyword`) holds the exact value used for filtering, faceting and
sorting. Dates, numbers and booleans take no suffix, and some text fields
(`title`, `content`, `url`, `subject`) have no `.keyword` variant at all — a
filter on one of those matches nothing rather than erroring. `iFinder.getFields`
reports the correct name per field per purpose.

**Example Usage:**

```javascript
// Basic search
iFinder.search({ query: 'contract proposals 2024' });

// Advanced search with options
iFinder.search({
  query: 'technical documentation',
  maxResults: 20,
  filter: ['application.keyword:PDF', 'modificationDate:[2026-01-01 TO *]'],
  returnFields: ['id', 'title', 'creators', 'modificationDate'],
  returnFacets: ['sourceName.keyword', 'language.keyword'],
  sort: ['modificationDate:desc']
});
```

**Response Format:**

```json
{
  "query": "contract proposals",
  "searchProfile": "default",
  "totalFound": 15,
  "took": "125ms",
  "results": [
    {
      "id": "doc123456",
      "title": "Q4 Contract Proposals",
      "content": "...",
      "author": "John Smith",
      "createdDate": "2024-01-15",
      "documentType": "pdf",
      "score": 0.95
    }
  ],
  "facets": {...}
}
```

### The IntraFind query syntax

iFinder does not run a plain Lucene query parser. The search service hands
OpenSearch the query as `intrafind_query_string` — a query type the IntraFind
Insight plugin registers — instead of the built-in `query_string`. That parser
takes all of Lucene's syntax plus a set of IntraFind operators, and they are
available in `query` and in `filter` through the public API's `_search`
endpoint:

| Operator | Does |
| --- | --- |
| `MODE/e&Müller` | Exact — no lemma, compound or diacritic loosening |
| `MODE/c&Bundesligaspiel` | Decompound — also matches documents saying just "Liga" |
| `THES/&Stiefel` | Expand with thesaurus synonyms, broader and narrower terms |
| `ENTITY/PERS` | Any person name, whatever it says — also `LOC`, `ORG`, `EMAIL`, `PHONE` |
| `NEAR/S(vertrag kündigung)` | Both terms in the same sentence (`P` paragraph, `5` within 5 tokens) |
| `UNIT/>=(5 kg)` | A weight over 5 kg written in the text, units converted |
| `DATE/>=(2026-01-01)` | A date in the text, however it is written |
| `NUMBER/[10 TO 100]` | A number in that range in the text |
| `OR/2(a b c d)` | OR group where at least 2 clauses must match |

Boolean operators also accept German aliases (`UND`, `ODER`, `NICHT`), and a
field prefix goes in front of any operator:
`content:NEAR/S(ENTITY/PERS AND Kündigungsfrist)`.

Do not confuse these with the request body's `"query_type": "QueryStringQuery"`.
That is the API's own discriminator for the *shape* of the query object; the
engine-level query type is chosen server-side.

The search service enables the IntraFind parser by default
(`searchservice.use-intrafind-queryparser`), and a search profile can override
the engine query type, so the operators are normally on but a deployment can
have them off. A parser that does not know an operator treats it as a literal
term and quietly matches nothing, so verify by running a query with and without
the operator and comparing `totalFound`.

The `ifinder-search` skill documents the full grammar, every option and worked
examples in `references/intrafind-query-syntax.md`.

### iFinder.getContent

Retrieve the full content of a specific document for analysis.

**Parameters:**

- `documentId` (required): Document ID to fetch
- `maxLength` (optional): Maximum content length (default: 50000)
- `searchProfile` (optional): Specific search profile ID

**Example Usage:**

```javascript
iFinder.getContent({
  documentId: 'doc123456',
  maxLength: 10000
});
```

**Response Format:**

```json
{
  "documentId": "doc123456",
  "content": "Full document text content...",
  "contentLength": 8542,
  "contentLengthFormatted": "8.5K characters",
  "metadata": {
    "title": "Q4 Contract Proposals",
    "author": "John Smith",
    "documentType": "pdf",
    "mimeType": "application/pdf"
  },
  "truncated": false
}
```

### iFinder.getMetadata

Get detailed metadata for a specific document without fetching content.

**Parameters:**

- `documentId` (required): Document ID to fetch metadata for
- `searchProfile` (optional): Specific search profile ID

**Example Usage:**

```javascript
iFinder.getMetadata({ documentId: 'doc123456' });
```

**Response Format:**

```json
{
  "documentId": "doc123456",
  "title": "Q4 Contract Proposals",
  "documentType": "pdf",
  "mimeType": "application/pdf",
  "size": 2048576,
  "sizeFormatted": "2.0 MB",
  "author": "John Smith",
  "createdDate": "2024-01-15T10:30:00Z",
  "lastModified": "2024-01-16T14:25:00Z",
  "pageCount": 25,
  "wordCount": 5420,
  "tags": ["contracts", "proposals", "q4"],
  "categories": ["legal", "business"]
}
```

### iFinder.download

Get download information or save documents locally.

**Parameters:**

- `documentId` (required): Document ID to download
- `action` (optional): "content" for info, "save" for local save (default: "content")
- `filename` (optional): Custom filename for downloads
- `searchProfile` (optional): Specific search profile ID

**Example Usage:**

```javascript
// Get download information
iFinder.download({
  documentId: 'doc123456',
  action: 'content'
});

// Save document locally
iFinder.download({
  documentId: 'doc123456',
  action: 'save',
  filename: 'contract-proposal.pdf'
});
```

## Usage Examples

### Basic Document Search

```
User: "Find documents about artificial intelligence from 2024"
AI: I'll search for documents about artificial intelligence from 2024.

[Uses iFinder.search with query "artificial intelligence 2024"]

I found 8 documents about artificial intelligence from 2024:

1. "AI Strategy Report 2024" by Jane Doe (PDF, 2.1MB)
2. "Machine Learning Implementation Guide" by Tech Team (DOCX, 856KB)
3. "AI Ethics Guidelines" by Legal Department (PDF, 1.2MB)
...
```

### Document Analysis

```
User: "Can you analyze document doc789012 and summarize its key points?"
AI: I'll fetch the content of document doc789012 and analyze it for you.

[Uses iFinder.getContent to retrieve full document text]
[Analyzes content and provides summary]

Based on the document "AI Implementation Strategy", here are the key points:

1. **Executive Summary**: The organization plans to integrate AI across 3 departments
2. **Timeline**: 18-month rollout starting Q2 2024
3. **Budget**: $2.3M allocated for AI infrastructure
...
```

### Multi-step Document Discovery

```
User: "I need information about our latest contracts"
AI: Let me search for recent contract documents.

[Uses iFinder.search with query "contracts latest"]

I found 12 recent contract documents. Would you like me to:
1. Show you the most recent ones
2. Analyze a specific contract
3. Summarize all contract activity

User: "Show me details about the top 3 most recent ones"
AI: [Uses iFinder.getMetadata for top 3 documents]

Here are the 3 most recent contracts:

1. **Service Agreement - TechCorp** (doc456789)
   - Signed: March 15, 2024
   - Value: $150,000
   - Duration: 12 months
   - 15 pages, PDF format
...
```

## User Interface

### iFinder Document Explorer App

The system includes a pre-configured app called "iFinder Document Explorer" that provides:

- **Natural Language Interface**: Users can ask questions about documents
- **Conversational AI**: Maintains context throughout the conversation
- **Multi-language Support**: Available in English and German
- **Smart Tool Selection**: AI automatically chooses the right tools for each request

**App Configuration:**

- **App ID**: `ifinder-document-explorer`
- **Tools**: `iFinder.search`, `iFinder.getContent`, `iFinder.getMetadata`, `iFinder.download`
- **Features**: Chat history, model selection, output formatting

### Example User Interactions

1. **"Find all documents by John Smith from last month"**
   - AI uses `iFinder.search` with appropriate query
   - Returns filtered results with metadata

2. **"What's in document XYZ123?"**
   - AI uses `iFinder.getContent` to fetch full text
   - Provides summary and key information

3. **"Compare the content of documents A and B"**
   - AI fetches content from both documents
   - Performs comparative analysis

4. **"Download the latest contract for review"**
   - AI searches for recent contracts
   - Provides download information or saves locally

### Passage Highlighting in the Document Preview

When an answer cites iFinder documents, the **Documents** section below the answer lists each
document with the passages the search backend returned. Those passages can be located and
highlighted in the source document:

- Expanding a document shows its passages; each has a magnifier button that opens the document at
  that passage.
- The document's overflow menu offers **Preview (PDF)**, which opens the same viewer with all of
  that document's cited passages highlighted.
- The viewer navigates highlight to highlight (buttons, or `Enter` / `Shift+Enter`), supports zoom
  and download, and — when a document is cited more than once — can filter down to a single
  passage.

Both entries appear only for documents that expose an `ACCESS` link, which is what the
`/api/integrations/ifinder/document` proxy needs to resolve the binary. The preview requests that
proxy with `convertToPdf=true`, i.e. the PDF rendition iFinder generates for the document.

**How passages are located.** A passage is a substring of the fulltext that the converter put into
the search index, but the preview is a *generated* PDF whose text layer differs from that fulltext:
whitespace and line breaks fall differently, ligatures may be expanded or not, words can be
hyphenated across lines, and page headers or footers appear in the middle of the text stream.
Matching therefore does not compare the strings directly. Both the passage and the page text are
reduced to their Unicode letters and digits (NFKC-folded, lowercased), and the passage is searched
in that reduced form, with an offset map back to the real text-layer positions. Consequences worth
knowing:

- Punctuation, spacing, casing and ligature differences never prevent a match, and matches are not
  script-specific — Cyrillic, Greek and CJK passages work the same as Latin ones.
- Passages that straddle a page break are highlighted on both pages.
- If a header or footer interrupts a passage at a page break, the passage is split into
  sentence-like fragments and matched individually, so it is highlighted partially rather than not
  at all.
- Highlights begin and end on a letter or digit, so trailing punctuation of a passage is not
  included in the highlight.
- If a passage genuinely does not occur in the generated PDF, the preview still opens and reports
  "Passage not found".

The matcher (`client/src/features/documentPreview/utils/passageMatcher.js`) is a port of the same
module used by the iFinder searchbar preview, so both products resolve passages identically. Keep
the two in sync when changing either.

## Security Considerations

### Authentication & Authorization

- **User-Based Access**: All iFinder operations use the authenticated user's context
- **JWT Security**: Tokens are signed with RS256 and include user identity
- **Permission Enforcement**: iFinder's built-in security controls access
- **No Anonymous Access**: Anonymous users cannot access iFinder features

### Data Protection

- **Encrypted Communication**: All API calls use HTTPS
- **Token Expiration**: JWT tokens have configurable expiration (default: 1 hour)
- **Audit Logging**: All document access is logged with user information
- **Content Filtering**: Large documents are truncated to prevent memory issues

### Configuration Security

- **Private Key Protection**: Store JWT private keys securely
- **Environment Variables**: Use environment variables for sensitive configuration
- **Access Control**: Limit who can configure iFinder settings

## Troubleshooting

### Common Issues

#### "iFinder search requires authenticated user"

- **Cause**: User is anonymous or not properly authenticated
- **Solution**: Ensure user is logged in through your authentication system

#### "iFinder authentication failed. Please check JWT configuration."

- **Cause**: Invalid private key or JWT configuration
- **Solution**:
  - Verify private key is in correct PEM format
  - Check that key matches iFinder's public key
  - Ensure algorithm is RS256

#### "iFinder search request timed out"

- **Cause**: Network issues or slow iFinder instance
- **Solution**:
  - Increase `IFINDER_TIMEOUT` environment variable
  - Check network connectivity to iFinder instance

#### "Document not found: doc123456"

- **Cause**: Document ID doesn't exist or user lacks permissions
- **Solution**:
  - Verify document ID is correct
  - Check user has access rights in iFinder
  - Try searching to find the correct document ID

### Debugging

Enable debug logging by checking server logs for:

- `iFinder Search: User X searching for "query"`
- `iFinder Content: Fetching content for document...`
- `Generating iFinder JWT for user...`

### Configuration Testing

Test your iFinder configuration:

1. **Check Connection**: Verify `IFINDER_API_URL` is accessible
2. **Test Authentication**: Try a simple search as an authenticated user
3. **Validate JWT**: Use iFinder's token validation endpoint if available
4. **Verify Permissions**: Ensure users have proper iFinder access rights

## API Reference

### Configuration Options

| Setting          | Environment Variable     | Platform Config                | Default                           | Description                                                                    |
| ---------------- | ------------------------ | ------------------------------ | --------------------------------- | ------------------------------------------------------------------------------ |
| Base URL         | `IFINDER_API_URL`        | `iFinder.baseUrl`              | `https://api.ifinder.example.com` | iFinder instance URL                                                           |
| Search Profile   | `IFINDER_SEARCH_PROFILE` | `iFinder.defaultSearchProfile` | `default`                         | Default search profile ID                                                      |
| Keyless (OIDC)   | -                        | `iFinder.useOidcKeyPair`       | `false`                           | Sign with iHub's OIDC key and verify via JWKS — no key exchange (recommended)  |
| Private Key      | `IFINDER_PRIVATE_KEY`    | `iFinder.privateKey`           | -                                 | JWT signing private key (PEM format); ignored when `useOidcKeyPair` is `true`  |
| Timeout          | `IFINDER_TIMEOUT`        | `iFinder.timeout`              | `30000`                           | Request timeout (milliseconds)                                                 |
| Download Dir     | `IFINDER_DOWNLOAD_DIR`   | `iFinder.downloadDir`          | `/tmp/ifinder-downloads`          | Local download directory                                                       |

### Error Codes

| Error       | Meaning                    | Resolution                                |
| ----------- | -------------------------- | ----------------------------------------- |
| `ENOENT`    | iFinder instance not found | Check `IFINDER_API_URL`                   |
| `401`       | Authentication failed      | Verify JWT configuration and private key  |
| `403`       | Access denied              | Check user permissions in iFinder         |
| `404`       | Document not found         | Verify document ID or search for document |
| `413`       | Content too large          | Reduce `maxLength` parameter              |
| `ETIMEDOUT` | Request timed out          | Increase `IFINDER_TIMEOUT` setting        |

## Best Practices

### Performance

- **Use Appropriate Limits**: Set reasonable `maxResults` for searches
- **Cache Search Results**: Consider caching frequent queries
- **Content Length Limits**: Use `maxLength` to control memory usage
- **Timeout Configuration**: Set appropriate timeouts for your network

### User Experience

- **Progressive Disclosure**: Show summaries before full content
- **Search Refinement**: Help users refine broad searches
- **Context Preservation**: Maintain conversation context for better UX
- **Error Handling**: Provide clear error messages to users

### Security

- **Regular Key Rotation**: Rotate JWT private keys periodically
- **Audit Access**: Monitor who accesses which documents
- **Principle of Least Privilege**: Users should only access necessary documents
- **Secure Configuration**: Protect configuration files and environment variables

## Support

For technical support with iFinder integration:

1. **Check Logs**: Review server logs for detailed error messages
2. **Test Configuration**: Verify all configuration settings
3. **Check iFinder Status**: Ensure iFinder instance is accessible
4. **Contact Support**: Provide logs and configuration details (redact sensitive info)

---

## Lazy corpus workflows

The audit-grade `stellungnahmen-review` workflow expects each
Stellungnahme to be uploaded into chat. For ministry-scale
consultations that produces 200+ documents and breaks the chat upload
ceiling. A second workflow ships alongside it:

**`stellungnahmen-review-ifinder`** — same extract-and-report flow,
same evidence schema, but candidates come from iFinder by topic and
each document's fulltext is fetched one at a time inside the iteration
loop.

Key shape:

1. `corpus-search` runs with `fetchFulltext: false`, so it returns
   only the candidate metadata (no fulltext yet).
2. An LLM `refine-decision` node inspects the candidate list and can
   request 1-3 additional topics. The outer search loop is capped at
   3 rounds (`_maxSearchIterations`).
3. The per-document loop calls `iFinder_getContent` as a `tool` node
   for the current document only. `advance-doc` clears
   `_currentDocContent` between iterations.
4. The extract prompt and JSON schema are identical to the upload
   variant — same audit guarantees, same downstream consumers.

Trade-off: lazy loading shifts cost from "200 calls up front" to
"N calls in-loop". When every candidate is processed the totals are
equal; when refinement filtering prunes candidates, lazy wins.

Trigger via chat with `@workflow stellungnahmen-review-ifinder` and
supply the focus prompt + search profile ID.

## Discovering what is searchable

A caller that has to guess field names gets silent empty result sets, because a
filter on a field that carries no `.keyword` variant matches nothing rather than
failing. These four functions let a client — an app, an agent, or an MCP client
such as Claude — read the answer off the deployment instead.

### iFinder.getFields

Returns the index field catalog, straight from the live OpenSearch mapping via
`GET /public-api/retrieval/api/v1/schema-types/{schemaType}/fields`.

**Parameters:**

- `schemaType` (optional): Schema type to describe, default `document`
- `filterPrefix` (optional): Only return fields whose name starts with this
  prefix, e.g. `file.` or `cust.`

**Response:**

```json
{
  "schemaType": "document",
  "totalFields": 157,
  "fields": {
    "creators": {
      "type": "text",
      "fullTextSearch": "creators",
      "filter": "creators.keyword",
      "aggregation": "creators.keyword",
      "sort": "creators.keyword"
    },
    "content": {
      "type": "text",
      "fullTextSearch": "content",
      "filter": null,
      "aggregation": null,
      "sort": null
    },
    "modificationDate": {
      "type": "date",
      "fullTextSearch": null,
      "filter": "modificationDate",
      "aggregation": "modificationDate",
      "sort": "modificationDate"
    }
  },
  "fullTextSearchable": ["..."],
  "filterable": ["..."],
  "aggregatable": ["..."],
  "sortable": ["..."]
}
```

A `null` means the field does not serve that purpose. This is also the only way
to learn a deployment's custom `cust.*` fields, which no static documentation
can list.

### iFinder.getFacetValues

Enumerates the values of a single facet — which sources, authors, applications
or languages actually exist — with a document count per value. Returns far more
values than the capped facet block that rides along with a search response.

**Parameters:**

- `facet` (required): An aggregatable field name. Text fields need their
  `.keyword` variant (`creators.keyword`).
- `query` (optional): Scope query, default `*`
- `filter` (optional): Additional Lucene filters narrowing what is counted
- `maxValues` (optional): Default 50, max 1000
- `sort` (optional): `count:desc` (default), `value:asc`, `value:desc`
- `searchProfile` (optional)

```javascript
iFinder.getFacetValues({ facet: 'application.keyword', maxValues: 100 });
// → { facet, values: [{ value: 'PDF', count: 4210 }, ...], hasMore: false }
```

Use it before filtering on a value: casing and spelling are deployment data, so
`application.keyword:pdf` and `application.keyword:PDF` are not the same query.

### iFinder.listProfiles

Lists the search profiles the calling user can reach.

The iFinder public API has no "list search profiles" endpoint — profile listing
lives on the administration API, which an end-user token cannot reach. What the
public API does expose is `GET /public-api/v0/assistants`, and every iAssistant
names the search profile it is composed with, already filtered to the ones the
caller may use. This function derives the profile list from there and always
includes the configured default.

A deployment with no iAssistants configured therefore reports only the
configured default. That is a limit of the upstream API, not an error; the call
degrades to the default rather than failing when the assistants endpoint is
unavailable.

### iFinder.discover

One probe over a search profile, returning its document count, the top values of
the main facets, sample document titles, the field catalog, and a ready-to-paste
markdown summary.

**Parameters:**

- `searchProfile` (required)
- `query` (optional): Scope query, default `*:*`
- `facets` (optional): Facet fields to probe
- `sampleSize` (optional): Sample documents to list, default 10
- `includeFields` (optional): Also fetch the field catalog, default `true`

Run it once against an unfamiliar profile before searching it. The `markdown`
field is what the admin "build memory from tool" endpoint writes into an agent
profile's long-term memory — see
[Admin-driven corpus discovery](#admin-driven-corpus-discovery).

### Using it from an MCP client

Over the MCP gateway these are `iFinder_getFields`, `iFinder_getFacetValues`,
`iFinder_listProfiles` and `iFinder_discover`, and they need the calling group
to hold the `iFinder` tool permission (`permissions.tools` in `groups.json`).

The **`ifinder-search` skill** shipped in `contents/skills/` teaches a client the
whole surface — query syntax, the `.keyword` rule, filters versus query terms,
facets, paging, and the discovery loop — with a full field reference and a query
cookbook alongside it. Grant it to a group and it is offered over the gateway as
an MCP resource (`ihub://skill/ifinder-search`).

## Admin-driven corpus discovery

Some workflows benefit from a precomputed "corpus map" — which sources
contribute, which languages are represented, what the typical document
titles look like — so a downstream planner doesn't have to discover
this at runtime. iHub exposes a generic admin endpoint for this:

```
POST /api/admin/agents/profiles/<profileId>/memory/from-tool
  { "toolId": "iFinder_discover",
    "params": { "searchProfile": "searchprofile-xyz", "query": "*:*" },
    "section": "iFinder corpus map",
    "mode": "replace-section" }
```

The endpoint runs the named tool with admin context and writes the
result to the agent profile's long-term memory under the given heading
(`## iFinder corpus map`). Subsequent agent runs see that section
through the existing memory auto-include; the
`stellungnahmen-review-ifinder` workflow can also read it when started
with a non-empty `agentProfileId`.

**Access control**: the endpoint is gated by `adminAuth` — any
registered tool can be invoked with admin context. `iFinder_discover`
is intentionally NOT added to any default agent profile's `tools`
array, so agents at runtime cannot call it; only the admin endpoint
can. Operators re-run discovery when the underlying index changes
significantly.

---

_Last updated: September 2026_
