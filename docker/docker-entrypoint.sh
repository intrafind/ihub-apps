#!/bin/sh
# docker-entrypoint.sh - Container initialization script for iHub Apps

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

# Function to wait for a service to be ready
wait_for_service() {
    local host="$1"
    local port="$2"
    local timeout="${3:-30}"
    local service_name="${4:-$host:$port}"
    
    log_info "Waiting for $service_name to be ready..."
    
    for i in $(seq 1 $timeout); do
        if nc -z "$host" "$port" 2>/dev/null; then
            log_success "$service_name is ready"
            return 0
        fi
        
        if [ $i -eq 1 ] || [ $((i % 10)) -eq 0 ]; then
            log_info "Waiting for $service_name... ($i/$timeout)"
        fi
        
        sleep 1
    done
    
    log_error "Timeout waiting for $service_name"
    return 1
}

# Function to validate required environment variables
validate_env_vars() {
    # JWT_SECRET is now optional - the application auto-generates and persists it
    # For multi-node deployments, set JWT_SECRET explicitly to share across nodes
    if [ -z "$JWT_SECRET" ]; then
        log_info "JWT_SECRET not set - application will auto-generate and persist a secret"
    else
        log_info "Using JWT_SECRET from environment variable"
    fi
    
    # Warn about missing API keys (not critical for startup)
    if [ -z "$OPENAI_API_KEY" ] && [ -z "$ANTHROPIC_API_KEY" ] && [ -z "$GOOGLE_API_KEY" ] && [ -z "$MISTRAL_API_KEY" ]; then
        log_warn "No LLM API keys found. Some functionality may be limited."
    fi
    
    log_success "Environment validation passed"
}

# Function to display startup information
display_startup_info() {
    log_info "=== iHub Apps Container Starting ==="
    log_info "Node.js version: $(node --version)"
    log_info "Environment: ${NODE_ENV:-development}"
    log_info "Port: ${PORT:-3000}"
    log_info "Workers: ${WORKERS:-1}"
    log_info "User: $(whoami) (UID: $(id -u))"
    log_info "Working directory: $(pwd)"
    log_info "========================================"
}

# Main initialization function
main() {
    display_startup_info
    
    # Perform initialization steps
    validate_env_vars
    
    log_success "Container initialization completed successfully"
    log_info "Starting iHub Apps with command: $*"
    
    # Execute the main command
    exec "$@"
}

# Handle signals gracefully
trap 'log_info "Received signal, shutting down gracefully..."; exit 0' TERM INT

# Run main function with all arguments
main "$@"