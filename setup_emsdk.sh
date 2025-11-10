#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_EMSDK_DIR="${SCRIPT_DIR}/emsdk"

EMSDK_REPO_URL="https://github.com/emscripten-core/emsdk.git"
EMSDK_VERSION="latest"
INSTALL_DEPS=0
EMSDK_DIR="${DEFAULT_EMSDK_DIR}"

usage() {
  cat <<'EOF'
Usage: setup_emsdk.sh [options]

Installs or updates the Emscripten SDK within this repository (without using git submodules).
Run with --install-deps to install system packages required on Debian/Ubuntu.

Options:
  --emsdk-dir <path>    Directory where emsdk will be cloned (default: ./emsdk relative to script).
  --version <tag>       Emscripten SDK version to install (default: latest).
  --install-deps        Install required Debian/Ubuntu packages via apt-get.
  -h, --help            Show this help message and exit.

After this script completes, run:
  source <emsdk-dir>/emsdk_env.sh
to populate PATH and other environment variables in your current shell.
EOF
}

log() {
  printf '[setup_emsdk] %s\n' "$*"
}

install_dependencies() {
  if ! command -v apt-get >/dev/null 2>&1; then
    log "apt-get not found; skip automatic dependency installation."
    return 1
  fi
  if ! command -v sudo >/dev/null 2>&1; then
    log "sudo not found; cannot install packages automatically."
    return 1
  fi

  log "Installing build dependencies via apt-get..."
  sudo apt-get update
  sudo apt-get install -y build-essential cmake git python3
}

clone_or_update_repo() {
  if [ -d "${EMSDK_DIR}/.git" ]; then
    log "Updating existing emsdk repository at ${EMSDK_DIR}..."
    git -C "${EMSDK_DIR}" fetch --tags --prune
    git -C "${EMSDK_DIR}" reset --hard origin/main
  elif [ -e "${EMSDK_DIR}" ]; then
    log "Target path ${EMSDK_DIR} exists but is not a git repository."
    log "Please remove or rename it and rerun the script."
    exit 1
  else
    log "Cloning emsdk into ${EMSDK_DIR}..."
    git clone "${EMSDK_REPO_URL}" "${EMSDK_DIR}"
  fi
}

install_emsdk() {
  pushd "${EMSDK_DIR}" >/dev/null
  log "Installing Emscripten toolchain (${EMSDK_VERSION})..."
  ./emsdk install "${EMSDK_VERSION}"
  log "Activating Emscripten toolchain (${EMSDK_VERSION})..."
  ./emsdk activate "${EMSDK_VERSION}"
  popd >/dev/null
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --emsdk-dir)
      shift
      EMSDK_DIR="${1:-}"
      if [ -z "${EMSDK_DIR}" ]; then
        log "Error: --emsdk-dir requires a value."
        exit 1
      fi
      ;;
    --version)
      shift
      EMSDK_VERSION="${1:-}"
      if [ -z "${EMSDK_VERSION}" ]; then
        log "Error: --version requires a value."
        exit 1
      fi
      ;;
    --install-deps)
      INSTALL_DEPS=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      log "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
  shift
done

if [ "${INSTALL_DEPS}" -eq 1 ]; then
  install_dependencies || {
    log "Dependency installation failed."
    exit 1
  }
fi

clone_or_update_repo
install_emsdk

log "Emscripten SDK is ready. To use it in this shell, run:"
log "  source \"${EMSDK_DIR}/emsdk_env.sh\""
