#!/bin/sh
# Installs the runrail command line from a GitHub release, for macOS and Linux:
#
#   curl -fsSL https://github.com/TechDev009/runrail/releases/latest/download/install.sh | sh
#
# It downloads the archive for this machine and the release's SHA256SUMS.txt, refuses an archive
# that does not match it, and puts runrail in ~/.local/bin. It never uses sudo and never edits
# your shell's startup files. Options, as flags (after `sh -s --` when piped) or variables:
#
#   --version <v>   RUNRAIL_VERSION       a version such as 0.1.2 (default: the latest release)
#   --dir <path>    RUNRAIL_INSTALL_DIR   where runrail goes (default: ~/.local/bin)
#                   RUNRAIL_DOWNLOAD_URL  a folder holding the release's files, for a mirror
#
# On Windows (experimental), download runrail-<version>-windows-x64.zip from the release instead.
set -eu

REPO="TechDev009/runrail"

fail() {
  printf 'runrail install: %s\n' "$1" >&2
  exit 1
}

say() {
  printf '%s\n' "$1" >&2
}

platform() {
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    MINGW* | MSYS* | CYGWIN*) fail "on Windows, download runrail-<version>-windows-x64.zip from https://github.com/$REPO/releases" ;;
    *) fail "there is no runrail build for $os" ;;
  esac
  case "$arch" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) fail "there is no runrail build for $arch processors" ;;
  esac
  # A shell under Rosetta says x86_64 on Apple silicon, where the arm64 build runs natively.
  if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
    arch=arm64
  fi
  if [ "$os" = linux ] && (ldd --version 2>&1 || true) | grep -qi musl; then
    fail "the Linux builds need glibc; on musl (Alpine), install Bun and run: bun add -g runrail"
  fi
  printf '%s-%s' "$os" "$arch"
}

latest_version() {
  url=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest") || fail "could not reach GitHub to find the latest release"
  case "$url" in
    */releases/tag/v*) printf '%s' "${url##*/tag/v}" ;;
    *) fail "found no published release at https://github.com/$REPO/releases" ;;
  esac
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    fail "found neither sha256sum nor shasum to check the download with"
  fi
}

main() {
  version="${RUNRAIL_VERSION:-}"
  dir="${RUNRAIL_INSTALL_DIR:-}"
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --version) [ "$#" -ge 2 ] || fail "--version needs a value"; version="$2"; shift 2 ;;
      --dir) [ "$#" -ge 2 ] || fail "--dir needs a value"; dir="$2"; shift 2 ;;
      *) fail "unknown option $1 (see the top of install.sh)" ;;
    esac
  done
  [ -n "$dir" ] || dir="${HOME:?HOME is not set}/.local/bin"
  command -v curl >/dev/null 2>&1 || fail "curl is needed to download runrail"
  command -v tar >/dev/null 2>&1 || fail "tar is needed to unpack runrail"

  target=$(platform)
  [ -n "$version" ] || version=$(latest_version)
  version="${version#v}"
  printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' || fail "$version is not a version such as 0.1.2"

  base="${RUNRAIL_DOWNLOAD_URL:-https://github.com/$REPO/releases/download/v$version}"
  # The archive and its checksums come from one place, so the checksum only guards against a damaged download;
  # over plain http even that is open to whoever is on the path.
  case "$base" in
    https://*|http://localhost[:/]*|http://127.0.0.1[:/]*) ;;
    *) fail "RUNRAIL_DOWNLOAD_URL must be an https address (plain http is accepted only for localhost)" ;;
  esac
  stem="runrail-$version-$target"
  archive="$stem.tar.gz"
  tmp=$(mktemp -d 2>/dev/null || mktemp -d -t runrail)
  trap 'rm -rf "$tmp"' EXIT
  trap 'exit 130' INT TERM

  say "Downloading runrail $version for $target"
  curl -fsSL -o "$tmp/SHA256SUMS.txt" "$base/SHA256SUMS.txt" || fail "release v$version has no SHA256SUMS.txt at $base"
  curl -fSL --progress-bar -o "$tmp/$archive" "$base/$archive" || fail "release v$version has no $archive"
  expected=$(awk -v name="$archive" '$2 == name || $2 == "*" name { print $1; exit }' "$tmp/SHA256SUMS.txt")
  [ -n "$expected" ] || fail "SHA256SUMS.txt has no line for $archive"
  actual=$(sha256 "$tmp/$archive")
  [ "$actual" = "$expected" ] || fail "$archive does not match SHA256SUMS.txt (expected $expected, got $actual); nothing was installed"

  tar -xzf "$tmp/$archive" -C "$tmp"
  [ -f "$tmp/$stem/runrail" ] || fail "$archive has no $stem/runrail"
  mkdir -p "$dir"
  # Copied beside its place and renamed over it, so a runrail that is running keeps working.
  cp "$tmp/$stem/runrail" "$dir/.runrail.$$"
  chmod 755 "$dir/.runrail.$$"
  mv -f "$dir/.runrail.$$" "$dir/runrail"

  say "Installed runrail $("$dir/runrail" --version) in $dir"
  case ":${PATH:-}:" in
    *":$dir:"*) ;;
    *) say "" && say "$dir is not on your PATH. Add this line to your shell's startup file (~/.zshrc, ~/.bashrc):" && say "  export PATH=\"$dir:\$PATH\"" ;;
  esac
  say ""
  say "Next: runrail doctor checks this machine. For Claude Code to ask before it uses a tool,"
  say "runrail sdk install downloads Anthropic's Claude Agent SDK, after asking you."
}

main "$@"
