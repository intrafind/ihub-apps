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

The iFinder integration provides four main tools accessible through the `iFinder.` namespace:

### iFinder.search

Search for documents using natural language queries.

**Parameters:**

- `query` (required): Search query string
- `maxResults` (optional): Maximum results to return (default: 10, max: 100)
- `searchProfile` (optional): Specific search profile ID
- `returnFields` (optional): Array of specific fields to return
- `returnFacets` (optional): Array of facets to include
- `sort` (optional): Array of sort criteria

**Example Usage:**

```javascript
// Basic search
iFinder.search({ query: 'contract proposals 2024' });

// Advanced search with options
iFinder.search({
  query: 'technical documentation',
  maxResults: 20,
  returnFields: ['title', 'author', 'createdDate'],
  sort: ['createdDate:desc']
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

| Setting        | Environment Variable     | Platform Config                | Default                           | Description                          |
| -------------- | ------------------------ | ------------------------------ | --------------------------------- | ------------------------------------ |
| Base URL       | `IFINDER_API_URL`        | `iFinder.baseUrl`              | `https://api.ifinder.example.com` | iFinder instance URL                 |
| Search Profile | `IFINDER_SEARCH_PROFILE` | `iFinder.defaultSearchProfile` | `default`                         | Default search profile ID            |
| Private Key    | `IFINDER_PRIVATE_KEY`    | `iFinder.privateKey`           | -                                 | JWT signing private key (PEM format) |
| Timeout        | `IFINDER_TIMEOUT`        | `iFinder.timeout`              | `30000`                           | Request timeout (milliseconds)       |
| Download Dir   | `IFINDER_DOWNLOAD_DIR`   | `iFinder.downloadDir`          | `/tmp/ifinder-downloads`          | Local download directory             |

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

_Last updated: January 2025_
