# AI Developer Testing Guidelines

**Date**: 2025-01-24  
**Status**: Implementation Guide  
**Priority**: High

## Overview

This document provides specific guidelines for AI developers working on the ihub-apps platform. It ensures that all AI-generated code changes are properly tested and validated before deployment.

## Pre-Development Checklist

Before making any code changes, AI developers must:

- [ ] **Run existing tests**: Execute `npm run test:quick` to ensure current functionality works
- [ ] **Analyze impact**: Identify which components, APIs, or features will be affected
- [ ] **Plan test strategy**: Determine what new tests are needed
- [ ] **Check test coverage**: Review existing test coverage for the areas being modified

## Development Workflow for AI

### 1. Test-Driven Development (TDD) Approach

#### Step 1: Write Failing Tests First

```bash
# Create test file for new feature
touch tests/unit/server/new-feature.test.js

# Write failing test
npm run test:watch tests/unit/server/new-feature.test.js
```

#### Step 2: Implement Feature to Pass Tests

```bash
# Implement the minimal code to make tests pass
# Run tests continuously during development
npm run test:watch
```

#### Step 3: Refactor and Optimize

```bash
# Run full test suite to ensure no regressions
npm run test:all
```

### 2. Code Change Validation Process

#### For API Changes

```bash
# 1. Run API integration tests
npm run test:api

# 2. Test with real model integration (if API keys available)
npm run test:models

# 3. Validate existing functionality
npm run test:legacy
```

#### For Frontend Changes

```bash
# 1. Run frontend unit tests
npm run test:ui

# 2. Run E2E tests for affected user journeys
npm run test:e2e

# 3. Test responsive design and accessibility
npm run test:e2e -- --project="Mobile Chrome"
```

#### For Model Integration Changes

```bash
# 1. Test adapter functionality
npm run test:adapters

# 2. Test real model integration
TEST_REAL_API=true npm run test:models

# 3. Validate tool calling
npm run test:tool-calling
```

## Required Tests for Different Change Types

### API Endpoint Changes

**Must include:**

- Unit tests for business logic
- Integration tests for endpoint behavior
- Authentication/authorization tests
- Error handling tests
- Input validation tests

**Template:**

```javascript
// tests/integration/api/your-endpoint.test.js
describe('Your Endpoint API', () => {
  test('should handle valid requests', async () => {
    const headers = TestHelper.createAuthHeaders();
    const response = await request(app)
      .post('/api/your-endpoint')
      .set(headers)
      .send(validData)
      .expect(200);

    TestValidators.validateApiResponse(response, ['expectedField']);
  });

  test('should reject unauthorized requests', async () => {
    const response = await request(app).post('/api/your-endpoint').send(validData).expect(401);
  });
});
```

### Frontend Component Changes

**Must include:**

- Component unit tests
- User interaction tests
- State management tests
- Error boundary tests

**Template:**

```javascript
// tests/unit/client/YourComponent.test.jsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import YourComponent from '../../../client/src/components/YourComponent';

describe('YourComponent', () => {
  test('should render correctly', () => {
    render(<YourComponent />);
    expect(screen.getByTestId('your-component')).toBeInTheDocument();
  });

  test('should handle user interaction', async () => {
    const user = userEvent.setup();
    render(<YourComponent />);

    await user.click(screen.getByTestId('action-button'));
    expect(screen.getByTestId('result')).toBeInTheDocument();
  });
});
```

### Model Integration Changes

**Must include:**

- Adapter unit tests
- Real API integration tests (when keys available)
- Tool calling validation
- Error handling tests
- Response format validation

**Template:**

```javascript
// tests/integration/models/your-model.test.js
describe('Your Model Integration', () => {
  test('should handle chat completion', async () => {
    const response = await testModelCompletion(model, messages);
    TestHelper.validateModelResponse(response);
    expect(response.choices[0].message.content).toBeTruthy();
  });
});
```

## Automated Testing Commands

### Quick Validation (Use Before Every Commit)

```bash
npm run test:quick && npm run lint:fix && npm run format:fix
```

### Complete Validation (Use Before Pull Requests)

```bash
npm run test:all && npm run lint:fix && npm run format:fix
```

### Continuous Development Testing

```bash
# Watch mode for active development
npm run test:watch

# E2E testing during UI development
npm run test:e2e -- --headed --project=chromium
```

## Error Handling and Debugging

### Common Test Failures and Solutions

#### 1. Authentication Test Failures

```bash
# Check JWT secret configuration
echo $JWT_SECRET

# Verify test user fixtures
cat tests/utils/fixtures.js
```

#### 2. Model Integration Test Failures

```bash
# Check API key availability
echo $OPENAI_API_KEY
echo $ANTHROPIC_API_KEY

# Run with mock responses
TEST_REAL_API=false npm run test:models
```

#### 3. E2E Test Failures

```bash
# Run with visible browser for debugging
npm run test:e2e -- --headed --timeout=60000

# Check test data attributes in components
grep -r "data-testid" client/src/
```

### Debugging Commands

```bash
# Run specific test with verbose output
VERBOSE_TESTS=true npm test -- --testNamePattern="your test name"

# Generate test coverage report
npm run test:coverage
open tests/coverage/lcov-report/index.html

# Run E2E tests with trace
npm run test:e2e -- --trace=on
```

## Test Data Management

### Using Test Fixtures

```javascript
import { testUsers, testApps, testModels } from '../utils/fixtures.js';

// Use predefined test data
const user = testUsers.regularUser;
const app = testApps.generalChat;
const model = testModels.openai;
```

### Creating Custom Test Data

```javascript
import { TestHelper } from '../utils/helpers.js';

// Generate unique test data
const testId = TestHelper.generateTestId('feature');
const authHeaders = TestHelper.createAuthHeaders(customUser);
```

### Cleanup After Tests

```javascript
afterEach(async () => {
  await TestHelper.cleanupTestData();
});
```

## Performance Testing Guidelines

### Response Time Validation

```javascript
test('should respond within acceptable time', async () => {
  const startTime = Date.now();
  const response = await makeApiCall();
  const responseTime = Date.now() - startTime;

  expect(response.status).toBe(200);
  expect(responseTime).toBeLessThan(5000); // 5 second max
});
```

### Load Testing

```javascript
test('should handle concurrent requests', async () => {
  const promises = Array(10)
    .fill()
    .map(() => makeApiCall());
  const responses = await Promise.all(promises);

  responses.forEach(response => {
    expect(response.status).toBe(200);
  });
});
```

## Security Testing Requirements

### Authentication Tests

```javascript
test('should reject requests without valid token', async () => {
  const response = await request(app).get('/api/protected-endpoint').expect(401);
});

test('should reject expired tokens', async () => {
  const expiredToken = TestHelper.generateExpiredToken();
  const response = await request(app)
    .get('/api/protected-endpoint')
    .set('Authorization', `Bearer ${expiredToken}`)
    .expect(401);
});
```

### Input Validation Tests

```javascript
test('should validate input parameters', async () => {
  const invalidData = { maliciousInput: '<script>alert("xss")</script>' };
  const response = await request(app).post('/api/endpoint').send(invalidData).expect(400);
});
```

## CI/CD Integration

### Pre-commit Hook Setup

```bash
# Install husky hooks
npx husky install

# Add pre-commit test hook
npx husky add .husky/pre-commit "npm run test:quick"
```

### GitHub Actions Workflow

```yaml
# .github/workflows/test.yml
name: Test Suite
on: [push, pull_request]
jobs:
  test:
    steps:
      - name: Run Tests
        run: |
          npm run test:all
          npm run lint:fix
          npm run format:fix
```

## Documentation Requirements

### Test Documentation

- Document complex test scenarios
- Explain test data setup
- Document performance expectations
- Include troubleshooting guides

### Code Comments in Tests

```javascript
// Test covers authentication bypass vulnerability fix
test('should prevent authentication bypass', async () => {
  // This test ensures that the vulnerability reported in issue #123 is fixed
  // by verifying that all API endpoints require valid authentication
  const response = await request(app).get('/api/sensitive-data').expect(401);
});
```

## Quality Gates

### Minimum Requirements Before Deployment

- [ ] All new features have unit tests
- [ ] API changes have integration tests
- [ ] UI changes have E2E tests
- [ ] Test coverage > 80% for new code
- [ ] All tests pass consistently
- [ ] Performance benchmarks met
- [ ] Security tests pass

### Test Coverage Targets

- **Unit Tests**: 90% statement coverage
- **Integration Tests**: All API endpoints covered
- **E2E Tests**: Critical user journeys covered
- **Model Tests**: All providers tested

## Maintenance and Updates

### Regular Test Maintenance

```bash
# Weekly test health check
npm run test:all
npm audit

# Update test dependencies
npm update @playwright/test jest supertest

# Review flaky tests
npm run test:all --verbose | grep -i "flaky\|timeout\|intermittent"
```

### Test Refactoring Guidelines

- Keep tests simple and focused
- Use descriptive test names
- Avoid test interdependencies
- Regular cleanup of obsolete tests
- Update tests when refactoring code

## Success Metrics

### Development Velocity

- Time to implement and test features
- Frequency of regressions
- Time to identify and fix bugs

### Quality Metrics

- Test pass rate > 99%
- Code coverage > 80%
- Mean time to resolution < 24 hours
- Zero critical security vulnerabilities

### Reliability Metrics

- Uptime > 99.9%
- API response time < 500ms
- E2E test stability > 95%
- Model integration reliability > 99%

## Emergency Procedures

### Test Failure Response

1. **Immediate**: Stop deployment pipeline
2. **Investigate**: Run failed tests locally
3. **Fix**: Address root cause
4. **Validate**: Re-run full test suite
5. **Deploy**: Only after all tests pass

### Rollback Procedures

```bash
# Quick rollback testing
git checkout previous-working-commit
npm run test:quick

# If tests pass, deploy rollback
npm run prod:build
```

## Conclusion

Following these guidelines ensures that all AI-generated code changes are properly tested, validated, and safe for deployment. The testing framework provides comprehensive coverage while maintaining development velocity and code quality.

Remember: **No code changes should be deployed without passing tests.** When in doubt, write more tests rather than fewer.
