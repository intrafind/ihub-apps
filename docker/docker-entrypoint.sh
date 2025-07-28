#!/bin/sh
# docker-entrypoint.sh - Container initialization script for AI Hub Apps

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
    local missing_vars=""
    
    # Check for JWT_SECRET
    if [ -z "$JWT_SECRET" ]; then
        missing_vars="$missing_vars JWT_SECRET"
    fi
    
    # Warn about missing API keys (not critical for startup)
    if [ -z "$OPENAI_API_KEY" ] && [ -z "$ANTHROPIC_API_KEY" ] && [ -z "$GOOGLE_API_KEY" ] && [ -z "$MISTRAL_API_KEY" ]; then
        log_warn "No LLM API keys found. Some functionality may be limited."
    fi
    
    if [ -n "$missing_vars" ]; then
        log_error "Required environment variables not set:$missing_vars"
        log_error "Please check your environment configuration"
        exit 1
    fi
    
    log_success "Environment validation passed"
}

# Function to initialize directories
init_directories() {
    log_info "Initializing directories..."
    
    # Create required directories if they don't exist
    mkdir -p \
        /app/contents/data \
        /app/contents/uploads \
        /app/contents/config \
        /app/contents/pages \
        /app/contents/sources \
        /app/logs
    
    # Set proper permissions for writable directories
    if [ "$(id -u)" = "0" ]; then
        # Running as root, set ownership to aihub user
        chown -R aihub:nodejs \
            /app/contents/data \
            /app/contents/uploads \
            /app/contents/pages \
            /app/contents/sources \
            /app/logs 2>/dev/null || log_warn "Could not set directory ownership"
    else
        # Running as non-root, just ensure directories are accessible
        chmod 755 \
            /app/contents/data \
            /app/contents/uploads \
            /app/contents/pages \
            /app/contents/sources \
            /app/logs 2>/dev/null || log_warn "Could not set directory permissions"
    fi
    
    log_success "Directory initialization completed"
}

# Function to check and create default configuration
init_config() {
    log_info "Checking configuration files..."
    
    # Check if basic configuration exists
    if [ ! -f "/app/contents/config/platform.json" ]; then
        log_warn "Platform configuration not found. This may cause startup issues."
    fi
    
    if [ ! -f "/app/contents/config/ui.json" ]; then
        log_warn "UI configuration not found. Using defaults."
    fi
    
    # Check if at least one app is configured
    if [ ! -d "/app/contents/apps" ] || [ -z "$(ls -A /app/contents/apps 2>/dev/null)" ]; then
        log_warn "No apps configured. Users may have limited functionality."
    fi
    
    # Check if at least one model is configured
    if [ ! -d "/app/contents/models" ] || [ -z "$(ls -A /app/contents/models 2>/dev/null)" ]; then
        log_warn "No models configured. Chat functionality may not work."
    fi
    
    log_success "Configuration check completed"
}

# Function to wait for external services
wait_for_external_services() {
    log_info "Checking external service dependencies..."
    
    # Wait for database if configured
    if [ -n "$DATABASE_HOST" ]; then
        wait_for_service "$DATABASE_HOST" "${DATABASE_PORT:-5432}" 60 "PostgreSQL Database"
    fi
    
    # Wait for Redis if configured
    if [ -n "$REDIS_HOST" ]; then
        wait_for_service "$REDIS_HOST" "${REDIS_PORT:-6379}" 30 "Redis Cache"
    fi
    
    log_success "External service checks completed"
}

# Function to display startup information
display_startup_info() {
    log_info "=== AI Hub Apps Container Starting ==="
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
    init_directories
    init_config
    wait_for_external_services
    
    log_success "Container initialization completed successfully"
    log_info "Starting AI Hub Apps with command: $*"
    
    # Execute the main command
    exec "$@"
}

# Handle signals gracefully
trap 'log_info "Received signal, shutting down gracefully..."; exit 0' TERM INT

# Run main function with all arguments
main "$@"