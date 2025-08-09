#!/bin/bash

# Test Framework Validation Script
# This script validates that the test framework is properly set up

echo "🧪 Validating Test Framework Setup..."
echo "======================================"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Track validation results
ERRORS=0

# Function to check if command exists
check_command() {
    if command -v $1 &> /dev/null; then
        echo -e "${GREEN}✓${NC} $1 is available"
    else
        echo -e "${RED}✗${NC} $1 is not available"
        ERRORS=$((ERRORS + 1))
    fi
}

# Function to check if file exists
check_file() {
    if [[ -f $1 ]]; then
        echo -e "${GREEN}✓${NC} $1 exists"
    else
        echo -e "${RED}✗${NC} $1 not found"
        ERRORS=$((ERRORS + 1))
    fi
}

# Function to check if directory exists
check_dir() {
    if [[ -d $1 ]]; then
        echo -e "${GREEN}✓${NC} $1 exists"
    else
        echo -e "${RED}✗${NC} $1 not found"
        ERRORS=$((ERRORS + 1))
    fi
}

echo
echo "📦 Checking Dependencies..."
echo "----------------------------"
check_command node
check_command npm
check_command npx

echo
echo "📁 Checking Test Structure..."
echo "-----------------------------"
check_dir "tests"
check_dir "tests/config"
check_dir "tests/e2e"
check_dir "tests/integration"
check_dir "tests/unit"
check_dir "tests/utils"
check_dir "tests/fixtures"

echo
echo "⚙️  Checking Configuration Files..."
echo "-----------------------------------"
check_file "tests/config/jest.config.js"
check_file "tests/config/jest.setup.js"
check_file "tests/config/playwright.config.js"
check_file ".env.test"
check_file "tests/README.md"

echo
echo "🧰 Checking Test Utilities..."
echo "-----------------------------"
check_file "tests/utils/fixtures.js"
check_file "tests/utils/helpers.js"
check_file "tests/AI_DEVELOPER_GUIDELINES.md"

echo
echo "📋 Checking Test Examples..."
echo "----------------------------"
check_file "tests/e2e/chat.spec.js"
check_file "tests/integration/api/chat.test.js"
check_file "tests/integration/models/model-integration.test.js"
check_file "tests/unit/client/chat-component.test.jsx"

echo
echo "🔧 Checking Package.json Scripts..."
echo "-----------------------------------"
if grep -q "test:all" package.json; then
    echo -e "${GREEN}✓${NC} test:all script exists"
else
    echo -e "${RED}✗${NC} test:all script missing"
    ERRORS=$((ERRORS + 1))
fi

if grep -q "test:quick" package.json; then
    echo -e "${GREEN}✓${NC} test:quick script exists"
else
    echo -e "${RED}✗${NC} test:quick script missing"
    ERRORS=$((ERRORS + 1))
fi

if grep -q "test:e2e" package.json; then
    echo -e "${GREEN}✓${NC} test:e2e script exists"
else
    echo -e "${RED}✗${NC} test:e2e script missing"
    ERRORS=$((ERRORS + 1))
fi

echo
echo "📊 Running Quick Validation Tests..."
echo "------------------------------------"

# Test that existing adapter tests still work
echo "Testing existing adapters..."
if npm run test:adapters > /dev/null 2>&1; then
    echo -e "${GREEN}✓${NC} Adapter tests pass"
else
    echo -e "${YELLOW}⚠${NC} Adapter tests failed (this may be due to missing API keys)"
fi

# Test that the health check works
echo "Testing health check..."
if npm run health > /dev/null 2>&1; then
    echo -e "${GREEN}✓${NC} Health check passes"
else
    echo -e "${YELLOW}⚠${NC} Health check failed (server may not be running)"
fi

echo
echo "📈 Generating Summary..."
echo "------------------------"

if [[ $ERRORS -eq 0 ]]; then
    echo -e "${GREEN}🎉 Test framework validation PASSED!${NC}"
    echo -e "${GREEN}All required files and configurations are in place.${NC}"
    echo
    echo "Next steps:"
    echo "1. Run 'npm run test:quick' to execute basic tests"
    echo "2. Run 'npm run test:adapters' to test model adapters"
    echo "3. See tests/README.md for comprehensive usage guide"
    echo "4. See tests/AI_DEVELOPER_GUIDELINES.md for development guidelines"
else
    echo -e "${RED}❌ Test framework validation FAILED!${NC}"
    echo -e "${RED}Found $ERRORS errors that need to be fixed.${NC}"
    exit 1
fi

echo
echo "🚀 Framework Ready for Use!"
echo "==========================="