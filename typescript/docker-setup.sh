#!/usr/bin/env bash
# OpenRappter Docker Setup Script
# Automated setup for Docker deployment

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."

    if ! command -v docker &> /dev/null; then
        log_error "Docker is not installed. Please install Docker first."
        exit 1
    fi

    if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
        log_error "Docker Compose is not installed. Please install Docker Compose first."
        exit 1
    fi

    log_success "Prerequisites check passed"
}

# Create config directory and default config
setup_config() {
    log_info "Setting up configuration..."

    mkdir -p config

    if [[ ! -f config/openrappter.yaml ]]; then
        cat > config/openrappter.yaml << 'EOF'
# OpenRappter Configuration
# https://github.com/kody-w/openrappter

models:
  - id: default
    provider: openai
    model: gpt-4o-mini
    fallbacks:
      - provider: anthropic
        model: claude-3-haiku-20240307
      - provider: ollama
        model: llama3.2

agents:
  defaults:
    model: default
    sandbox: true
  list:
    - id: assistant
      name: Assistant
      description: General-purpose AI assistant

channels:
  cli:
    enabled: true
  discord:
    enabled: false
  slack:
    enabled: false
  telegram:
    enabled: false

gateway:
  port: 18789
  bind: all
  auth:
    mode: none

memory:
  provider: openai
  chunkTokens: 512
  chunkOverlap: 50

cron:
  enabled: true
EOF
        log_success "Created default configuration at config/openrappter.yaml"
    else
        log_info "Configuration already exists at config/openrappter.yaml"
    fi
}

# Create .env file for secrets
setup_env() {
    log_info "Setting up environment..."

    if [[ ! -f .env ]]; then
        cat > .env << 'EOF'
# OpenRappter Environment Variables
# Add your API keys here

# OpenAI API Key (for GPT models and embeddings)
OPENAI_API_KEY=

# Anthropic API Key (for Claude models)
ANTHROPIC_API_KEY=

# Ollama Host (for local LLMs)
OLLAMA_HOST=http://host.docker.internal:11434

# Discord Bot Token
DISCORD_TOKEN=

# Slack Bot Token
SLACK_BOT_TOKEN=

# Telegram Bot Token
TELEGRAM_BOT_TOKEN=
EOF
        log_success "Created .env file - please add your API keys"
    else
        log_info ".env file already exists"
    fi
}

# Build Docker image
build_image() {
    log_info "Building Docker image..."

    docker build -t openrappter:latest .

    log_success "Docker image built successfully"
}

# Start services
start_services() {
    log_info "Starting services..."

    # Use docker compose (v2) or docker-compose (v1)
    if docker compose version &> /dev/null; then
        docker compose up -d
    else
        docker-compose up -d
    fi

    log_success "Services started"
}

# Stop services
stop_services() {
    log_info "Stopping services..."

    if docker compose version &> /dev/null; then
        docker compose down
    else
        docker-compose down
    fi

    log_success "Services stopped"
}

# Show logs
show_logs() {
    if docker compose version &> /dev/null; then
        docker compose logs -f
    else
        docker-compose logs -f
    fi
}

# Health check
health_check() {
    log_info "Checking gateway health..."

    local max_retries=10
    local retry=0

    while [[ $retry -lt $max_retries ]]; do
        if curl -sf http://localhost:18789/health > /dev/null 2>&1; then
            log_success "Gateway is healthy"
            return 0
        fi

        retry=$((retry + 1))
        log_info "Waiting for gateway to start... ($retry/$max_retries)"
        sleep 2
    done

    log_error "Gateway health check failed"
    return 1
}

# Show usage
usage() {
    cat << EOF
OpenRappter Docker Setup Script

Usage: $0 <command>

Commands:
    setup       Full setup: check prerequisites, create config, build image, start services
    build       Build Docker image only
    start       Start services
    stop        Stop services
    restart     Restart services
    logs        Show service logs
    health      Check gateway health
    shell       Open shell in gateway container
    clean       Stop services and remove volumes
    help        Show this help message

Examples:
    $0 setup    # First-time setup
    $0 start    # Start after setup
    $0 logs     # View logs
    $0 health   # Check if gateway is running

EOF
}

# Main
main() {
    case "${1:-help}" in
        setup)
            check_prerequisites
            setup_config
            setup_env
            build_image
            start_services
            sleep 3
            health_check
            log_success "OpenRappter is ready! Gateway running at http://localhost:18789"
            ;;
        build)
            build_image
            ;;
        start)
            start_services
            ;;
        stop)
            stop_services
            ;;
        restart)
            stop_services
            start_services
            ;;
        logs)
            show_logs
            ;;
        health)
            health_check
            ;;
        shell)
            docker exec -it openrappter-gateway /bin/sh
            ;;
        clean)
            log_warn "This will remove all data volumes!"
            read -p "Are you sure? (y/N) " -n 1 -r
            echo
            if [[ $REPLY =~ ^[Yy]$ ]]; then
                if docker compose version &> /dev/null; then
                    docker compose down -v
                else
                    docker-compose down -v
                fi
                log_success "Services stopped and volumes removed"
            fi
            ;;
        help|--help|-h)
            usage
            ;;
        *)
            log_error "Unknown command: $1"
            usage
            exit 1
            ;;
    esac
}

main "$@"
