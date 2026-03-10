#!/usr/bin/env sh
# iHub Apps Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/intrafind/ihub-apps/main/install.sh | sh
# Or with options: curl -fsSL https://raw.githubusercontent.com/intrafind/ihub-apps/main/install.sh | sh -s -- --start

set -e

REPO="intrafind/ihub-apps"
BINARY_NAME="ihub-apps"

# Colors (only if terminal supports it)
if [ -t 1 ]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  BLUE='\033[0;34m'
  BOLD='\033[1m'
  NC='\033[0m'
else
  RED='' GREEN='' YELLOW='' BLUE='' BOLD='' NC=''
fi

info()    { printf "${BLUE}==>${NC} ${BOLD}%s${NC}\n" "$1" >&2; }
success() { printf "${GREEN}✓${NC} %s\n" "$1" >&2; }
warn()    { printf "${YELLOW}warning:${NC} %s\n" "$1" >&2; }
error()   { printf "${RED}error:${NC} %b\n" "$1" >&2; exit 1; }

# ── Helpers ──────────────────────────────────────────────────────────────────

need_cmd() {
  if ! command -v "$1" > /dev/null 2>&1; then
    error "Required command not found: $1"
  fi
}

have_cmd() {
  command -v "$1" > /dev/null 2>&1
}

download() {
  local url="$1"
  local dest="$2"
  if have_cmd curl; then
    curl -fsSL --proto '=https' --tlsv1.2 -o "$dest" "$url"
  elif have_cmd wget; then
    wget -q --https-only -O "$dest" "$url"
  else
    error "Neither curl nor wget is available. Please install one and retry."
  fi
}

download_stdout() {
  local url="$1"
  if have_cmd curl; then
    curl -fsSL --proto '=https' --tlsv1.2 "$url"
  elif have_cmd wget; then
    wget -q --https-only -O - "$url"
  else
    error "Neither curl nor wget is available. Please install one and retry."
  fi
}

# ── Platform detection ────────────────────────────────────────────────────────

detect_os() {
  local os
  os="$(uname -s)"
  case "$os" in
    Linux*)  echo "linux"  ;;
    Darwin*) echo "macos"  ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
    *)       error "Unsupported OS: $os. Windows users should use the .zip release from https://github.com/${REPO}/releases" ;;
  esac
}

detect_arch() {
  local arch
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) echo "x64"   ;;
    arm64|aarch64) echo "arm64" ;;
    *) warn "Unknown architecture: $arch — attempting to use the default binary"; echo "x64" ;;
  esac
}

# ── Latest release lookup ─────────────────────────────────────────────────────

get_latest_version() {
  local api_url="https://api.github.com/repos/${REPO}/releases/latest"
  local version
  version="$(download_stdout "$api_url" | grep '"tag_name"' | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')"
  if [ -z "$version" ]; then
    error "Could not determine the latest release version. Check your internet connection."
  fi
  echo "$version"
}

# ── Checksum verification ─────────────────────────────────────────────────────

verify_checksum() {
  local file="$1"
  local checksums_file="$2"
  local filename
  filename="$(basename "$file")"

  if [ ! -f "$checksums_file" ]; then
    warn "Checksums file not found — skipping verification."
    return 0
  fi

  local expected
  expected="$(grep -F "$filename" "$checksums_file" 2>/dev/null | awk '{print $1}')"

  if [ -z "$expected" ]; then
    warn "No checksum entry found for $filename — skipping verification."
    return 0
  fi

  local actual
  if have_cmd sha256sum; then
    actual="$(sha256sum "$file" | awk '{print $1}')"
  elif have_cmd shasum; then
    actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  else
    warn "sha256sum/shasum not available — skipping checksum verification."
    return 0
  fi

  if [ "$actual" = "$expected" ]; then
    success "Checksum verified."
  else
    error "Checksum mismatch for $filename!\n  Expected: $expected\n  Got:      $actual"
  fi
}

# ── Docker check ──────────────────────────────────────────────────────────────

check_docker() {
  if ! have_cmd docker; then
    return 1
  fi
  if ! docker info > /dev/null 2>&1; then
    return 1
  fi
  return 0
}

offer_docker() {
  local version="${1:-latest}"
  # Skip Docker offer if no TTY is available for user interaction (e.g. CI/CD pipelines)
  if ! [ -c /dev/tty ]; then
    return 0
  fi
  printf "\n${YELLOW}Docker is available on this system.${NC}\n"
  printf "Would you like to run iHub Apps via Docker instead of the binary? [y/N] "
  read -r reply </dev/tty 2>/dev/null || reply=""
  case "$reply" in
    [Yy]*)
      info "Pulling iHub Apps Docker image (${version})..."
      docker pull "intrafind/ihub-apps:${version}"
      success "Docker image pulled successfully."
      printf "\nRun iHub Apps with:\n"
      printf "  ${BOLD}docker run -d --name ihub-apps -p 3000:3000 intrafind/ihub-apps:${version}${NC}\n\n"
      exit 0
      ;;
  esac
}

# ── Install ───────────────────────────────────────────────────────────────────

install_binary() {
  local os="$1"
  local version="$2"

  local archive_name="${BINARY_NAME}-${version}-${os}.tar.gz"
  local download_url="https://github.com/${REPO}/releases/download/${version}/${archive_name}"
  local checksums_url="https://github.com/${REPO}/releases/download/${version}/checksums.sha256"

  local tmp_dir
  tmp_dir="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp_dir'" EXIT INT TERM

  local archive_path="${tmp_dir}/${archive_name}"
  local checksums_path="${tmp_dir}/checksums.sha256"

  info "Downloading iHub Apps ${version} for ${os}..."
  download "$download_url" "$archive_path"
  success "Downloaded ${archive_name}"

  # Try to download checksums (non-fatal if not present)
  download "$checksums_url" "$checksums_path" 2>/dev/null || true
  verify_checksum "$archive_path" "$checksums_path"

  info "Extracting archive..."
  local extract_dir="${tmp_dir}/extracted"
  mkdir -p "$extract_dir"
  tar -xzf "$archive_path" -C "$extract_dir"

  # Find the launcher inside the extracted content (may be nested in a subdirectory)
  local launcher_path
  launcher_path="$(find "$extract_dir" -maxdepth 2 -type f -name "${BINARY_NAME}-*-${os}" | head -n 1)"
  if [ -z "$launcher_path" ]; then
    launcher_path="$(find "$extract_dir" -maxdepth 2 -type f -name "${BINARY_NAME}*" ! -name "*.txt" ! -name "*.sh" ! -name "*.bat" ! -name "*.tar.gz" ! -name "*.zip" | head -n 1)"
  fi
  if [ -z "$launcher_path" ]; then
    error "Could not find the ${BINARY_NAME} launcher in the extracted archive."
  fi

  # The bundle directory contains the launcher and all companion files (node, launcher.cjs, server/, etc.)
  local bundle_dir
  bundle_dir="$(dirname "$launcher_path")"

  # Install the full bundle to ./ihub-apps/ in the current working directory
  local install_dir="./ihub-apps"
  if [ -d "$install_dir" ]; then
    info "Removing existing installation at ${install_dir}..."
    rm -rf "$install_dir"
  fi
  cp -rp "$bundle_dir" "$install_dir"

  local launcher_name
  launcher_name="$(basename "$launcher_path")"
  local new_launcher_path="${install_dir}/${launcher_name}"
  chmod +x "$new_launcher_path"

  success "Installed to ${install_dir}/"

  printf '%s' "$new_launcher_path"
}

# ── Main ──────────────────────────────────────────────────────────────────────

main() {
  # Parse arguments
  OPT_START=0
  OPT_VERSION=""
  for arg in "$@"; do
    case "$arg" in
      --start)    OPT_START=1 ;;
      --version=*) OPT_VERSION="${arg#--version=}" ;;
      -h|--help)
        printf "iHub Apps Installer\n\n"
        printf "Usage: install.sh [OPTIONS]\n\n"
        printf "Options:\n"
        printf "  --start          Start iHub Apps after installation\n"
        printf "  --version=TAG    Install a specific version (e.g. --version=v4.2.0)\n"
        printf "  -h, --help       Show this help\n\n"
        exit 0
        ;;
    esac
  done

  printf "\n${BOLD}iHub Apps Installer${NC}\n"
  printf "════════════════════\n\n"

  # Validate OS
  local os
  os="$(detect_os)"
  if [ "$os" = "windows" ]; then
    error "Windows binary installation via shell script is not supported.\nPlease download the .zip from https://github.com/${REPO}/releases"
  fi

  local arch
  arch="$(detect_arch)"
  info "Detected platform: ${os} (${arch})"
  if [ "$arch" != "x64" ]; then
    warn "No native ${arch} binary is available — falling back to x64. This may require Rosetta 2 (macOS) or CPU emulation (Linux)."
  fi

  need_cmd uname
  need_cmd tar

  # Docker offer
  if check_docker; then
    offer_docker "$OPT_VERSION"
  fi

  # Resolve version
  local version="$OPT_VERSION"
  if [ -z "$version" ]; then
    info "Fetching latest release version..."
    version="$(get_latest_version)"
  fi
  info "Installing version: ${version}"

  # Install
  install_path="$(install_binary "$os" "$version")"

  # Summary
  printf "\n%b%biHub Apps %s installed successfully!%b\n\n" "${GREEN}" "${BOLD}" "${version}" "${NC}"
  printf "Location: %b./ihub-apps/%b\n\n" "${BOLD}" "${NC}"
  printf "Run iHub Apps:\n"
  printf "  %bcd ihub-apps && ./%s%b\n" "${BOLD}" "$(basename "$install_path")" "${NC}"
  printf "  # or\n"
  printf "  %b%s%b\n\n" "${BOLD}" "${install_path}" "${NC}"
  printf "Docs & support:\n"
  printf "  https://github.com/%s\n\n" "${REPO}"

  # Start if requested
  if [ "$OPT_START" = "1" ]; then
    info "Starting iHub Apps..."
    exec "$install_path"
  fi
}

main "$@"
