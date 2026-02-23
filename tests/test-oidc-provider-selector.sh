#!/bin/bash
# Manual Test Script for OIDC Provider Template Selector
# This script helps verify the feature is working correctly

echo "==================================="
echo "OIDC Provider Template Selector Test"
echo "==================================="
echo ""

# Check if the implementation files exist
echo "✓ Checking implementation files..."

if [ -f "client/src/features/admin/components/PlatformFormEditor.jsx" ]; then
    echo "  ✓ PlatformFormEditor.jsx exists"
else
    echo "  ✗ PlatformFormEditor.jsx NOT FOUND"
    exit 1
fi

if [ -f "shared/i18n/en.json" ]; then
    echo "  ✓ en.json exists"
else
    echo "  ✗ en.json NOT FOUND"
    exit 1
fi

if [ -f "shared/i18n/de.json" ]; then
    echo "  ✓ de.json exists"
else
    echo "  ✗ de.json NOT FOUND"
    exit 1
fi

echo ""
echo "✓ Verifying template definitions..."

# Check if OIDC_PROVIDER_TEMPLATES exists in the file
if grep -q "OIDC_PROVIDER_TEMPLATES" client/src/features/admin/components/PlatformFormEditor.jsx; then
    echo "  ✓ OIDC_PROVIDER_TEMPLATES found"
else
    echo "  ✗ OIDC_PROVIDER_TEMPLATES NOT FOUND"
    exit 1
fi

# Check for each template
for provider in "auth0" "google" "microsoft" "keycloak" "custom"; do
    if grep -q "$provider:" client/src/features/admin/components/PlatformFormEditor.jsx; then
        echo "  ✓ $provider template found"
    else
        echo "  ✗ $provider template NOT FOUND"
    fi
done

echo ""
echo "✓ Verifying modal component..."

if grep -q "showProviderModal" client/src/features/admin/components/PlatformFormEditor.jsx; then
    echo "  ✓ Modal state variable found"
else
    echo "  ✗ Modal state variable NOT FOUND"
    exit 1
fi

if grep -q "Select OIDC Provider" client/src/features/admin/components/PlatformFormEditor.jsx; then
    echo "  ✓ Modal component found"
else
    echo "  ✗ Modal component NOT FOUND"
    exit 1
fi

echo ""
echo "✓ Verifying translations..."

# Check English translations
if grep -q "addOidcProvider" shared/i18n/en.json; then
    echo "  ✓ English translations found"
    # Count the number of new keys
    count=$(grep -c "Description\|customProvider" shared/i18n/en.json || echo "0")
    echo "    Found $count translation keys"
else
    echo "  ✗ English translations NOT FOUND"
fi

# Check German translations
if grep -q "addOidcProvider" shared/i18n/de.json; then
    echo "  ✓ German translations found"
    # Count the number of new keys
    count=$(grep -c "Description\|customProvider" shared/i18n/de.json || echo "0")
    echo "    Found $count translation keys"
else
    echo "  ✗ German translations NOT FOUND"
fi

echo ""
echo "✓ Verifying button update..."

if grep -q "setShowProviderModal(true)" client/src/features/admin/components/PlatformFormEditor.jsx; then
    echo "  ✓ Button handler updated to open modal"
else
    echo "  ✗ Button handler NOT updated"
    exit 1
fi

echo ""
echo "✓ Verifying function signature..."

if grep -q "addOidcProvider = (templateType" client/src/features/admin/components/PlatformFormEditor.jsx; then
    echo "  ✓ Function signature updated to accept templateType"
else
    echo "  ✗ Function signature NOT updated"
    exit 1
fi

echo ""
echo "==================================="
echo "All checks passed! ✓"
echo "==================================="
echo ""
echo "Manual Testing Steps:"
echo "1. Start the dev server: npm run dev"
echo "2. Login as admin (username: admin, password: password123)"
echo "3. Navigate to Admin > Authentication"
echo "4. Enable OIDC Authentication"
echo "5. Click 'Add OIDC Provider' button"
echo "6. Verify modal appears with 5 provider options"
echo "7. Click on each provider and verify form is pre-filled"
echo "8. Click 'Custom' and verify form is empty"
echo "9. Test Cancel button"
echo "10. Test Close (X) button"
echo "11. Switch language to German and verify translations"
echo ""
echo "Expected Results:"
echo "- Modal opens smoothly"
echo "- All 5 providers visible with icons and descriptions"
echo "- Google template pre-fills with Google URLs"
echo "- Microsoft template pre-fills with Microsoft URLs"
echo "- Auth0 template pre-fills with Auth0 URLs"
echo "- Keycloak template pre-fills with Keycloak URLs"
echo "- Custom template creates empty form"
echo "- Modal closes without changes when Cancel/X clicked"
echo "- All text appears in correct language"
echo ""
