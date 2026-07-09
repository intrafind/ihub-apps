# Admin Sources API Documentation

## Overview

This document describes the comprehensive Swagger/OpenAPI documentation added to the `/server/routes/admin/sources.js` file on 2025-08-07. All 15 endpoints have been fully documented with detailed schemas, parameters, request/response specifications, and error handling.

## Documented Endpoints

### Core Source Management
1. **GET /api/admin/sources** - List all sources
   - Retrieves all configured sources with ETag caching support
   - Returns array of Source objects

2. **GET /api/admin/sources/{id}** - Get specific source
   - Retrieves single source by ID
   - Returns Source object or 404 if not found

3. **POST /api/admin/sources** - Create new source
   - Creates new source with validation
   - Includes examples for different source types (filesystem, url, ifinder, page)
   - Validates configuration and checks for duplicate IDs

4. **PUT /api/admin/sources/{id}** - Update source
   - Updates existing source configuration
   - Preserves creation timestamp and validates ID match

5. **DELETE /api/admin/sources/{id}** - Delete source
   - Deletes source after checking dependencies
   - Returns error if source is used by apps

### Source Operations
6. **POST /api/admin/sources/{id}/test** - Test source connection
   - Tests source connectivity and configuration
   - Returns connection status and duration

7. **POST /api/admin/sources/{id}/preview** - Preview source content
   - Retrieves content preview with configurable limit
   - Supports content truncation with metadata

### Bulk Operations
8. **POST /api/admin/sources/_toggle** - Bulk toggle sources
   - Enable/disable multiple sources at once
   - Accepts array of source IDs and target state

### Statistics & Metadata
9. **GET /api/admin/sources/_stats** - Get sources statistics
   - Returns comprehensive statistics about all sources
   - Includes counts by type, status, and exposure method

10. **GET /api/admin/sources/_types** - Get available source types
    - Lists all supported source types with descriptions
    - Includes default configurations for each type

11. **GET /api/admin/sources/_dependencies/{id}** - Get source dependencies
    - Finds apps and resources that depend on a source
    - Used for dependency validation before deletion

### Filesystem Operations
12. **GET /api/admin/sources/{id}/files** - List files for filesystem source
    - Lists files and directories for filesystem sources
    - Supports path parameter for subdirectory listing

13. **GET /api/admin/sources/{id}/files/content** - Get file content
    - Reads content of specific files from filesystem sources
    - Returns content with metadata

14. **POST /api/admin/sources/{id}/files** - Write file for filesystem source
    - Creates or overwrites files in filesystem sources
    - Supports different encoding options

15. **DELETE /api/admin/sources/{id}/files** - Delete file for filesystem source
    - Deletes files from filesystem sources
    - Requires file path parameter

## Schema Definitions

### Core Schemas
- **Source** - Complete source configuration with discriminated union for type-specific configs
- **FilesystemConfig** - Configuration for filesystem sources
- **URLConfig** - Configuration for URL sources with HTTP options
- **IFinderConfig** - Configuration for iFinder integration
- **PageConfig** - Configuration for page-based sources
- **CachingConfig** - Caching configuration for sources

### Response Schemas
- **SourceStats** - Statistical data about sources
- **SourceType** - Available source type information
- **TestResult** - Source connection test results
- **PreviewResult** - Content preview with metadata
- **SourceDependencies** - Source dependency information
- **FileSystemFiles** - File listing for filesystem sources
- **FileContent** - File content with metadata
- **OperationResult** - Generic operation result
- **ErrorResponse** - Standard error response format

### Request Schemas
- **BulkToggleRequest** - Bulk enable/disable request
- **FileWriteRequest** - File write operation request

## Key Features

### Comprehensive Error Handling
All endpoints document standard HTTP status codes:
- 200: Success responses with appropriate data
- 400: Bad request with validation errors
- 401: Unauthorized access
- 403: Insufficient admin permissions
- 404: Resource not found
- 500: Internal server errors

### Security Documentation
All endpoints properly document security requirements:
- `bearerAuth: []` for JWT token authentication
- `sessionAuth: []` for session-based authentication
- Admin access required for all endpoints

### Parameter Validation
Detailed parameter specifications including:
- Path parameters with regex patterns
- Query parameters with types and defaults
- Request body schemas with examples
- Validation rules and constraints

### Type-Specific Configuration
Source configurations use discriminated unions based on source type:
- Filesystem: Path and encoding options
- URL: HTTP method, headers, timeout, retry options
- iFinder: API integration with search profiles
- Page: Page ID and language configuration

### Example Requests
Request bodies include practical examples for:
- Creating filesystem sources
- Creating URL sources
- Bulk operations
- File operations

## Implementation Notes

### Consistency with Existing Patterns
The documentation follows the established patterns from other admin route files:
- Uses same tag structure (`Admin - Sources`)
- Consistent security definitions
- Standard error response schemas
- Similar parameter and response formatting

### Schema Organization
Schemas are organized logically:
1. Core configuration schemas first
2. Response schemas grouped by functionality
3. Request schemas for complex operations
4. Reusable error and operation result schemas

### Validation Integration
Documentation reflects the actual Zod validation schemas from:
- `sourceConfigSchema.js` for source configuration validation
- Path parameter validation patterns
- Required field specifications

## Future Maintenance

### Adding New Source Types
When adding new source types:
1. Add new config schema to components/schemas
2. Update Source schema's oneOf configuration section
3. Add examples for the new type in POST/PUT operations
4. Update SourceStats schema if needed

### Endpoint Modifications
For endpoint changes:
1. Update parameter specifications
2. Modify request/response schemas as needed
3. Update examples to reflect new functionality
4. Ensure error responses remain consistent

### Schema Updates
When updating validation schemas:
1. Sync OpenAPI schemas with Zod schemas
2. Update examples to use valid data
3. Verify response schemas match actual API responses
4. Test documentation with API testing tools

This comprehensive documentation enables developers to understand and integrate with the Sources Admin API effectively, providing clear specifications for all available operations and their expected behaviors.