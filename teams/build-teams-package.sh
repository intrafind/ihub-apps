#!/bin/bash

# Microsoft Teams App Package Builder
# This script creates a deployable Teams app package

set -e

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
PACKAGE_NAME="ihub-apps-teams.zip"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check required files
check_requirements() {
    log_info "Checking requirements..."
    
    # Check if manifest template exists
    if [[ ! -f "$SCRIPT_DIR/manifest.json" ]]; then
        log_error "manifest.json template not found in $SCRIPT_DIR"
        exit 1
    fi
    
    # Check if icons exist
    if [[ ! -f "$SCRIPT_DIR/icons/color.png" ]]; then
        log_warning "Color icon not found at $SCRIPT_DIR/icons/color.png"
        log_info "You'll need to add a 192x192px color.png icon before deployment"
    fi
    
    if [[ ! -f "$SCRIPT_DIR/icons/outline.png" ]]; then
        log_warning "Outline icon not found at $SCRIPT_DIR/icons/outline.png"  
        log_info "You'll need to add a 32x32px outline.png icon before deployment"
    fi
    
    log_success "Requirements check completed"
}

# Get configuration values
get_config() {
    log_info "Getting configuration..."
    
    # Prompt for required values if not set as environment variables
    if [[ -z "$TEAMS_APP_ID" ]]; then
        read -p "Enter Teams App ID (GUID): " TEAMS_APP_ID
    fi
    
    if [[ -z "$APP_URL" ]]; then
        read -p "Enter your iHub Apps URL (e.g., https://ihub.company.com): " APP_URL
    fi
    
    if [[ -z "$AAD_CLIENT_ID" ]]; then
        read -p "Enter Azure AD Client ID: " AAD_CLIENT_ID
    fi
    
    # Extract domain from URL
    VALID_DOMAIN=$(echo "$APP_URL" | sed -E 's|https?://([^/]+).*|\1|')
    
    log_info "Configuration:"
    log_info "  Teams App ID: $TEAMS_APP_ID"
    log_info "  App URL: $APP_URL"
    log_info "  Valid Domain: $VALID_DOMAIN"
    log_info "  AAD Client ID: $AAD_CLIENT_ID"
}

# Process manifest template
process_manifest() {
    log_info "Processing manifest template..."
    
    # Create build directory
    mkdir -p "$BUILD_DIR"
    
    # Copy and process manifest
    sed -e "s|{{TEAMS_APP_ID}}|$TEAMS_APP_ID|g" \
        -e "s|{{APP_URL}}|$APP_URL|g" \
        -e "s|{{VALID_DOMAIN}}|$VALID_DOMAIN|g" \
        -e "s|{{AAD_CLIENT_ID}}|$AAD_CLIENT_ID|g" \
        "$SCRIPT_DIR/manifest.json" > "$BUILD_DIR/manifest.json"
    
    log_success "Manifest processed successfully"
}

# Copy icons
copy_icons() {
    log_info "Copying icons..."
    
    if [[ -f "$SCRIPT_DIR/icons/color.png" ]]; then
        cp "$SCRIPT_DIR/icons/color.png" "$BUILD_DIR/"
        log_success "Color icon copied"
    else
        log_warning "Color icon not found - package will be incomplete"
    fi
    
    if [[ -f "$SCRIPT_DIR/icons/outline.png" ]]; then
        cp "$SCRIPT_DIR/icons/outline.png" "$BUILD_DIR/"
        log_success "Outline icon copied"
    else
        log_warning "Outline icon not found - package will be incomplete"
    fi
}

# Create package
create_package() {
    log_info "Creating Teams app package..."
    
    cd "$BUILD_DIR"
    
    # Remove existing package
    rm -f "$PACKAGE_NAME"
    
    # Create zip package
    if command -v zip &> /dev/null; then
        zip -r "$PACKAGE_NAME" manifest.json
        
        # Add icons if they exist
        [[ -f "color.png" ]] && zip -u "$PACKAGE_NAME" color.png
        [[ -f "outline.png" ]] && zip -u "$PACKAGE_NAME" outline.png
        
        log_success "Teams app package created: $BUILD_DIR/$PACKAGE_NAME"
    else
        log_error "zip command not found. Please install zip utility."
        exit 1
    fi
}

# Validate package
validate_package() {
    log_info "Validating package..."
    
    cd "$BUILD_DIR"
    
    # Check if package exists and has reasonable size
    if [[ -f "$PACKAGE_NAME" ]]; then
        PACKAGE_SIZE=$(du -h "$PACKAGE_NAME" | cut -f1)
        log_info "Package size: $PACKAGE_SIZE"
        
        # List contents
        log_info "Package contents:"
        unzip -l "$PACKAGE_NAME"
        
        log_success "Package validation completed"
    else
        log_error "Package not found"
        exit 1
    fi
}

# Display instructions
show_instructions() {
    log_success "Teams app package build completed!"
    echo
    log_info "Next steps:"
    echo "1. Review the package contents in: $BUILD_DIR"
    echo "2. Add your custom icons to the icons/ directory if not already done"
    echo "3. Upload $BUILD_DIR/$PACKAGE_NAME to Teams Admin Center or Teams client"
    echo "4. Configure your Azure AD app registration with the following settings:"
    echo "   - Application ID URI: api://$VALID_DOMAIN/$AAD_CLIENT_ID"
    echo "   - Redirect URI: $APP_URL/teams/auth-end"
    echo "   - API Permissions: User.Read, email, openid, profile"
    echo
    log_info "For detailed setup instructions, see teams/README.md"
}

# Main execution
main() {
    log_info "Building Microsoft Teams app package for iHub Apps"
    echo
    
    check_requirements
    get_config
    process_manifest
    copy_icons  
    create_package
    validate_package
    show_instructions
}

# Run main function
main "$@"