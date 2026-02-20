#!/usr/bin/env bash
# Install a pinned Beads CLI (`bd`) into a versioned, user-local prefix.
#
# v0.52+: Builds from source with CGO_ENABLED=1 (required for Dolt backend).
# Known issue: GitHub release binaries for v0.52.0 ship with CGO_ENABLED=0,
# which breaks Dolt init/operations. See:
#   https://github.com/steveyegge/beads/issues/1849
#   https://github.com/steveyegge/beads/issues/1856
#
# Build requirements:
#   - Go 1.25+ (auto-downloaded to ~/.local/go if not on PATH)
#   - gcc/g++ (C/C++ compiler for CGO)
#   - libicu (runtime libs) + libicu-devel (headers) for ICU regex support
#   - libzstd-devel for compression
#
# Rationale:
# - Avoids system-wide installs.
# - Allows multiple projects to pin different Beads versions concurrently.
# - Deterministic: explicit version pin.
# - CGO_ENABLED=1 required for Dolt backend in v0.50+.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BEADS_VERSION="${BEADS_VERSION:-$(cat "${SCRIPT_DIR}/beads_version")}"
BEADS_PREFIX_BASE="${BEADS_PREFIX_BASE:-${HOME}/.local/beads}"
PREFIX="${BEADS_PREFIX_BASE}/${BEADS_VERSION}"

# --- Go toolchain ---
GO_MIN_VERSION="1.24.0"
GO_INSTALL_VERSION="1.24.2"
GO_LOCAL="${HOME}/.local/go"

find_go() {
  # Check PATH first
  if command -v go >/dev/null 2>&1; then
    echo "$(command -v go)"
    return 0
  fi
  # Check user-local install
  if [[ -x "${GO_LOCAL}/bin/go" ]]; then
    echo "${GO_LOCAL}/bin/go"
    return 0
  fi
  return 1
}

install_go() {
  local os arch tarball url
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "${arch}" in
    x86_64)        arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) echo "ERROR: Unsupported architecture: ${arch}" >&2; exit 2 ;;
  esac

  tarball="go${GO_INSTALL_VERSION}.${os}-${arch}.tar.gz"
  url="https://go.dev/dl/${tarball}"

  echo "Installing Go ${GO_INSTALL_VERSION} to ${GO_LOCAL} ..."
  mkdir -p "$(dirname "${GO_LOCAL}")"
  curl -fsSL "${url}" | tar xz -C "$(dirname "${GO_LOCAL}")"
  echo "✓ Go installed: ${GO_LOCAL}/bin/go"
}

# --- ICU headers (for CGO build) ---
ensure_icu_headers() {
  # Check if headers are in standard locations
  if [[ -f /usr/include/unicode/uregex.h ]]; then
    return 0
  fi

  # Check user-local extracted headers
  local icu_local="${HOME}/.local/icu-devel"
  if [[ -f "${icu_local}/usr/include/unicode/uregex.h" ]]; then
    export CGO_CFLAGS="-I${icu_local}/usr/include ${CGO_CFLAGS:-}"
    export CGO_CXXFLAGS="-I${icu_local}/usr/include ${CGO_CXXFLAGS:-}"
    return 0
  fi

  echo "ICU development headers not found. Attempting to download..."

  # Detect distro
  if command -v dnf >/dev/null 2>&1; then
    # Fedora/RHEL
    mkdir -p /tmp/icu-rpm "${icu_local}"
    dnf download libicu-devel --destdir=/tmp/icu-rpm 2>/dev/null
    local rpm_file
    rpm_file="$(find /tmp/icu-rpm -name 'libicu-devel-*.x86_64.rpm' -o -name 'libicu-devel-*.aarch64.rpm' | head -1)"
    if [[ -n "${rpm_file}" ]]; then
      cd "${icu_local}" && rpm2cpio "${rpm_file}" | cpio -idm 2>/dev/null
      export CGO_CFLAGS="-I${icu_local}/usr/include ${CGO_CFLAGS:-}"
      export CGO_CXXFLAGS="-I${icu_local}/usr/include ${CGO_CXXFLAGS:-}"
      echo "✓ ICU headers extracted to ${icu_local}"
      rm -rf /tmp/icu-rpm
      return 0
    fi
  fi

  echo "ERROR: Could not obtain ICU development headers." >&2
  echo "Install libicu-devel (Fedora/RHEL) or libicu-dev (Debian/Ubuntu)." >&2
  exit 2
}

# --- ICU linker symlinks ---
ensure_icu_libs() {
  # Check if linker can find ICU libs already
  if ldconfig -p 2>/dev/null | grep -q "libicuuc.so "; then
    return 0
  fi

  # Create linker symlinks for versioned system libs
  local lib_dir="/lib64"
  [[ -d /lib64 ]] || lib_dir="/usr/lib"
  local link_dir="${HOME}/.local/icu-libs"
  mkdir -p "${link_dir}"

  for lib in icudata icui18n icuuc icuio icutu; do
    local target
    target="$(find "${lib_dir}" -name "lib${lib}.so.*" -not -name "*.so.*.*" 2>/dev/null | head -1)"
    if [[ -z "${target}" ]]; then
      target="$(find "${lib_dir}" -name "lib${lib}.so.*" 2>/dev/null | sort -V | tail -1)"
    fi
    if [[ -n "${target}" ]]; then
      ln -sf "${target}" "${link_dir}/lib${lib}.so"
    fi
  done

  export CGO_LDFLAGS="-L${link_dir} ${CGO_LDFLAGS:-}"
}

# --- Main ---
echo "Installing beads v${BEADS_VERSION} with CGO_ENABLED=1 (Dolt backend) ..."

mkdir -p "${PREFIX}/bin"

# 1. Ensure Go
GO_BIN=""
if GO_BIN="$(find_go)"; then
  echo "✓ Go found: ${GO_BIN}"
else
  install_go
  GO_BIN="${GO_LOCAL}/bin/go"
fi

# 2. Ensure C compiler
if ! command -v gcc >/dev/null 2>&1; then
  echo "ERROR: gcc not found. Install a C compiler (gcc)." >&2
  exit 2
fi

# 3. Ensure ICU headers + libs
ensure_icu_headers
ensure_icu_libs

# 4. Build from source
export PATH="$(dirname "${GO_BIN}"):${HOME}/go/bin:${PATH}"
export GOPATH="${HOME}/go"
export CGO_ENABLED=1

echo "Building bd v${BEADS_VERSION} from source (CGO_ENABLED=1)..."
"${GO_BIN}" install "github.com/steveyegge/beads/cmd/bd@v${BEADS_VERSION}"

# 5. Copy binary to pinned prefix
if [[ -x "${HOME}/go/bin/bd" ]]; then
  cp "${HOME}/go/bin/bd" "${PREFIX}/bin/bd"
  echo "✓ Installed CGO-enabled bd to: ${PREFIX}/bin/bd"
  "${PREFIX}/bin/bd" --version
  # Verify CGO
  if strings "${PREFIX}/bin/bd" | grep -q "CGO_ENABLED=1"; then
    echo "✓ CGO_ENABLED=1 confirmed in binary"
  else
    echo "⚠ WARNING: CGO_ENABLED=1 not detected in binary strings"
  fi
else
  echo "ERROR: Build succeeded but binary not found at ${HOME}/go/bin/bd" >&2
  exit 2
fi
