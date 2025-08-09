# Comprehensive Test Suite for ihub-apps

This directory contains the complete testing infrastructure for the ihub-apps platform, implementing the comprehensive test concept outlined in the project documentation.

## Quick Start

### Prerequisites
```bash
# Install all dependencies
npm run install:all

# Install Playwright browsers
npx playwright install
```

### Running Tests

#### Quick Validation (Development)
```bash
# Run essential tests before commits
npm run test:quick

# Watch mode for active development
npm run test:watch
```

#### Complete Test Suite
```bash
# Run all tests (unit, integration, e2e)
npm run test:all

# Run specific test categories
npm run test:unit        # Unit tests only
npm run test:integration # API integration tests
npm run test:e2e         # End-to-end browser tests
npm run test:models      # Model integration tests
```

#### Legacy Tests (Existing)
```bash
# Run existing adapter tests
npm run test:adapters
npm run test:legacy
```

## Test Structure

```
tests/
├── config/                    # Test configuration
│   ├── jest.config.js        # Jest configuration
│   ├── jest.setup.js         # Global test setup
│   └── playwright.config.js  # Playwright E2E config
├── e2e/                      # End-to-end tests
│   └── chat.spec.js          # Browser-based user journey tests
├── integration/              # Integration tests
│   ├── api/                  # API endpoint tests
│   │   └── chat.test.js      # Chat API integration tests
│   └── models/               # Model integration tests
│       └── model-integration.test.js
├── unit/                     # Unit tests
│   ├── client/               # Frontend unit tests
│   │   └── chat-component.test.jsx
│   └── server/               # Server unit tests
├── utils/                    # Test utilities
│   ├── fixtures.js           # Test data fixtures
│   └── helpers.js            # Test helper functions
├── fixtures/                 # Static test files
│   └── test-document.txt     # Sample files for testing
├── AI_DEVELOPER_GUIDELINES.md # Guidelines for AI developers
└── README.md                 # This file
```

## Test Categories

### 1. Unit Tests (`tests/unit/`)
- **Purpose**: Test individual components and functions in isolation
- **Framework**: Jest for server, Vitest for client
- **Coverage**: Aims for 90% statement coverage
- **Run with**: `npm run test:unit`

### 2. Integration Tests (`tests/integration/`)
- **Purpose**: Test API endpoints and service interactions
- **Framework**: Jest + Supertest
- **Coverage**: All API endpoints
- **Run with**: `npm run test:integration`

### 3. End-to-End Tests (`tests/e2e/`)
- **Purpose**: Test complete user journeys through the browser
- **Framework**: Playwright
- **Coverage**: Critical user flows
- **Run with**: `npm run test:e2e`

### 4. Model Integration Tests (`tests/integration/models/`)
- **Purpose**: Validate LLM provider integrations
- **Framework**: Jest with real API calls (when keys provided)
- **Coverage**: All supported model providers
- **Run with**: `npm run test:models`

## Configuration

### Environment Variables

#### Test Environment (`.env.test`)
```bash
# Copy and customize for your environment
cp .env.test.example .env.test
```

Key variables:
- `TEST_REAL_API=false` - Use mock responses by default
- `TEST_BASE_URL=http://localhost:3000` - Server URL for tests
- `OPENAI_API_KEY` - Required for real model testing
- `ANTHROPIC_API_KEY` - Required for real model testing

#### Test Modes
```bash
# Mock mode (default) - fast, no external dependencies
npm run test:models

# Real API mode - tests against actual model providers
TEST_REAL_API=true npm run test:models
```

### Browser Configuration

E2E tests run across multiple browsers:
- Chromium (Desktop)
- Firefox (Desktop)
- WebKit/Safari (Desktop)
- Mobile Chrome
- Mobile Safari

```bash
# Run specific browser
npm run test:e2e -- --project=chromium

# Run with visible browser (for debugging)
npm run test:e2e -- --headed
```

## Test Data and Fixtures

### Predefined Test Data (`tests/utils/fixtures.js`)
```javascript
import { testUsers, testApps, testModels } from '../utils/fixtures.js';

// Use consistent test data
const user = testUsers.regularUser;
const app = testApps.generalChat;
const model = testModels.openai;
```

### Test Utilities (`tests/utils/helpers.js`)
```javascript
import { TestHelper, MockDataGenerator } from '../utils/helpers.js';

// Generate auth headers
const headers = TestHelper.createAuthHeaders(user);

// Create mock responses
const mockResponse = MockDataGenerator.generateModelResponse();
```

## Writing Tests

### API Integration Tests
```javascript
import request from 'supertest';
import { TestHelper } from '../utils/helpers.js';

describe('Your API Endpoint', () => {
  test('should handle valid requests', async () => {
    const headers = TestHelper.createAuthHeaders();
    
    const response = await request(app)
      .post('/api/your-endpoint')
      .set(headers)
      .send(validData)
      .expect(200);
      
    expect(response.body).toHaveProperty('expectedField');
  });
});
```

### Frontend Component Tests
```javascript
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

describe('Your Component', () => {
  test('should render and handle interaction', async () => {
    const user = userEvent.setup();
    render(<YourComponent />);
    
    await user.click(screen.getByTestId('button'));
    expect(screen.getByTestId('result')).toBeInTheDocument();
  });
});
```

### E2E Tests
```javascript
import { test, expect } from '@playwright/test';

test('complete user journey', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-testid="input"]').fill('test message');
  await page.locator('[data-testid="send"]').click();
  await expect(page.locator('[data-testid="response"]')).toBeVisible();
});
```

### Model Integration Tests
```javascript
import { createCompletionRequest } from '../../server/adapters/index.js';

test('should integrate with model provider', async () => {
  const request = createCompletionRequest(model, messages, apiKey);
  const response = await fetch(request.url, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify(request.body)
  });
  
  expect(response.ok).toBe(true);
});
```

## Development Workflow

### 1. Before Making Changes
```bash
# Ensure current tests pass
npm run test:quick

# Check specific area you're modifying
npm run test:unit -- --testPathPattern="component-name"
```

### 2. During Development
```bash
# Use watch mode for rapid feedback
npm run test:watch

# Test specific file
npm test -- tests/path/to/your.test.js --watch
```

### 3. Before Committing
```bash
# Run comprehensive validation
npm run test:all && npm run lint:fix && npm run format:fix
```

### 4. Before Pull Request
```bash
# Full validation including E2E
npm run test:all
npm run test:e2e
```

## Debugging Tests

### Failed Tests
```bash
# Run with verbose output
VERBOSE_TESTS=true npm test -- --testNamePattern="failing test"

# Run single test file
npm test -- tests/path/to/failing.test.js
```

### E2E Test Debugging
```bash
# Run with visible browser
npm run test:e2e -- --headed --timeout=60000

# Generate trace for debugging
npm run test:e2e -- --trace=on

# Take screenshots on failure (default)
npm run test:e2e
```

### Model Integration Debugging
```bash
# Use mock responses for debugging
TEST_REAL_API=false npm run test:models

# Enable verbose logging
VERBOSE_TESTS=true npm run test:models
```

## CI/CD Integration

### GitHub Actions

The test suite integrates with GitHub Actions:

```yaml
# .github/workflows/test.yml
- name: Run Test Suite
  run: |
    npm run test:all
    npm run lint:fix
    npm run format:fix
```

### Pre-commit Hooks

Husky automatically runs tests before commits:

```bash
# .husky/pre-commit
npm run test:quick
npm run lint:fix
```

## Performance and Coverage

### Test Coverage
```bash
# Generate coverage report
npm run test:coverage

# View coverage report
open tests/coverage/lcov-report/index.html
```

### Performance Monitoring
- API response time: < 5 seconds
- Model response time: < 30 seconds
- E2E test duration: < 10 minutes total

### Quality Metrics
- Test pass rate: > 99%
- Code coverage: > 80%
- E2E stability: > 95%

## Troubleshooting

### Common Issues

#### 1. "Module not found" errors
```bash
# Ensure all dependencies are installed
npm run install:all

# Check Jest configuration paths
cat tests/config/jest.config.js
```

#### 2. Authentication test failures
```bash
# Check JWT secret
echo $JWT_SECRET

# Verify test environment
cat .env.test
```

#### 3. E2E tests timing out
```bash
# Increase timeout
npm run test:e2e -- --timeout=60000

# Run in headed mode to see what's happening
npm run test:e2e -- --headed
```

#### 4. Model integration failures
```bash
# Check API keys
echo $OPENAI_API_KEY

# Use mock mode for development
TEST_REAL_API=false npm run test:models
```

### Getting Help

1. Check this README for common solutions
2. Review test output for specific error messages
3. Use debug modes for more detailed information
4. Check the AI Developer Guidelines for testing standards

## Contributing

### Adding New Tests

1. **Choose the right test type**: Unit vs Integration vs E2E
2. **Use existing patterns**: Follow established test structure
3. **Include test data**: Use fixtures for consistent data
4. **Test error cases**: Include negative test scenarios
5. **Document complex tests**: Add comments for non-obvious test logic

### Test Naming Conventions

- **Test files**: `*.test.js` or `*.spec.js`
- **Test descriptions**: Use "should" statements
- **Test data**: Use `data-testid` attributes for E2E tests

### Code Review Checklist

- [ ] Tests cover the main functionality
- [ ] Error cases are tested
- [ ] Tests are not flaky
- [ ] Test data is appropriate
- [ ] Performance impact is acceptable

## Maintenance

### Regular Tasks

#### Weekly
```bash
# Check test health
npm run test:all

# Update dependencies
npm audit
npm update
```

#### Monthly
```bash
# Review flaky tests
npm run test:all --verbose | grep -i "flaky\|timeout"

# Update browser versions
npx playwright install
```

#### Quarterly
```bash
# Review test coverage
npm run test:coverage

# Performance benchmark review
npm run test:models -- --verbose
```

## Future Enhancements

### Planned Improvements
- Visual regression testing with screenshot comparison
- Automated accessibility testing
- Load testing with multiple concurrent users
- Integration with external monitoring tools
- AI-powered test generation and maintenance

### Experimental Features
- Mutation testing for test quality validation
- Property-based testing for edge case discovery
- Contract testing for API versioning
- Chaos engineering for resilience testing

## Conclusion

This comprehensive test suite provides confidence in code changes while maintaining development velocity. The combination of unit, integration, and E2E tests creates multiple layers of protection against regressions.

For detailed implementation guidelines, see `AI_DEVELOPER_GUIDELINES.md`.

Remember: **Tests are not just about finding bugs—they're about enabling confident development and reliable deployments.**