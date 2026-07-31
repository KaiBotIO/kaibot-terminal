#!/usr/bin/env bash
# KaiBot Executor installer — downloads the latest release binary for this host
# and installs it to ~/.local/bin (or $KAIBOT_INSTALL_DIR).
#
#   curl -fsSL https://raw.githubusercontent.com/KaiBotIO/kaibot-terminal/main/apps/kaibot-executor/scripts/install.sh | bash
#
# Env:
#   KAIBOT_INSTALL_DIR   install location (default: ~/.local/bin)
#   KAIBOT_UPDATE_REPO   GitHub owner/repo (default: KaiBotIO/kaibot-terminal)
#   KAIBOT_INSTALL_SERVICE=1   also register the login/boot service
set -euo pipefail

REPO="${KAIBOT_UPDATE_REPO:-KaiBotIO/kaibot-terminal}"
INSTALL_DIR="${KAIBOT_INSTALL_DIR:-$HOME/.local/bin}"

os="$(uname -s)"
arch="$(uname -m)"

case "$arch" in
  arm64|aarch64) arch="aarch64" ;;
  x86_64|amd64)  arch="x86_64" ;;
  *) echo "Unsupported architecture: $arch" >&2; exit 1 ;;
esac

case "$os" in
  Darwin) triple="${arch}-apple-darwin" ;;
  Linux)  triple="${arch}-unknown-linux-gnu" ;;
  *) echo "Unsupported OS: $os (use the Docker image on Windows servers)" >&2; exit 1 ;;
esac

# Binary + web UI ship together as one tarball so backend and frontend never
# drift out of version sync. dist/ lands next to the binary; the daemon serves it.
asset="kaibot-terminal-${triple}.tar.gz"
url="https://github.com/${REPO}/releases/latest/download/${asset}"

echo "Downloading ${asset}…"
mkdir -p "$INSTALL_DIR"
tmpdir="$(mktemp -d)"
if ! curl -fsSL "$url" -o "$tmpdir/release.tar.gz"; then
  echo "Download failed. No release asset for ${triple} yet?" >&2
  rm -rf "$tmpdir"
  exit 1
fi

# Integrity gate, same model as `kaibot-terminal self-update`: this binary holds
# exchange API keys and can install itself as a startup service, so an unverified
# download is arbitrary-binary RCE as the user. Fail closed — a missing,
# unparseable or mismatched checksum aborts with nothing installed.
if ! curl -fsSL "${url}.sha256" -o "$tmpdir/release.sha256"; then
  echo "Refusing to install: this release publishes no checksum (${asset}.sha256), so the download cannot be verified." >&2
  rm -rf "$tmpdir"
  exit 1
fi
expected="$(grep -oiE '[0-9a-f]{64}' "$tmpdir/release.sha256" | head -1 | tr '[:upper:]' '[:lower:]')"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmpdir/release.tar.gz" | cut -d' ' -f1)"
else
  actual="$(shasum -a 256 "$tmpdir/release.tar.gz" | cut -d' ' -f1)"
fi
if [ -z "$expected" ] || [ "$actual" != "$expected" ]; then
  echo "Refusing to install: ${asset} failed SHA-256 verification." >&2
  echo "  expected ${expected:-<none found>}" >&2
  echo "  actual   $actual" >&2
  rm -rf "$tmpdir"
  exit 1
fi
echo "Checksum verified (SHA-256)."

tar -xzf "$tmpdir/release.tar.gz" -C "$tmpdir"
install -m 0755 "$tmpdir/kaibot-terminal" "$INSTALL_DIR/kaibot-terminal"
rm -rf "$INSTALL_DIR/dist"
cp -R "$tmpdir/dist" "$INSTALL_DIR/dist"
rm -rf "$tmpdir"
echo "Installed → $INSTALL_DIR/kaibot-terminal (+ dist)"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "Note: add $INSTALL_DIR to your PATH." ;;
esac

if [ "${KAIBOT_INSTALL_SERVICE:-0}" = "1" ]; then
  "$INSTALL_DIR/kaibot-terminal" service install
fi

echo "Done. Run 'kaibot-terminal' to start, or 'kaibot-terminal help'."
