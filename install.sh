#!/bin/sh
# Install the Sessions sidebar into the Herdr app, update it, or take it out.
#
#   ./install.sh            install, or update an installed copy
#   ./install.sh --remove   put back the layouts it changed, and delete the mod
#
# Without a clone, the script fetches the rest itself:
#
#   curl -fsSL https://raw.githubusercontent.com/jeffarese/herdr-agents-sidebar/main/install.sh | sh
#
# The app's home is ~/.config/herdr-app, or $HERDR_APP_HOME. Needs python3.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || pwd)
command -v python3 >/dev/null 2>&1 || { echo "The installer needs python3." >&2; exit 1; }

# Run from a pipe, or from a copy of this file alone: fetch the rest.
if [ ! -f "$here/scripts/install.py" ] || [ ! -f "$here/mods/agent-sidebar/main.js" ]; then
  tarball=${HERDR_SIDEBAR_TARBALL:-https://github.com/jeffarese/herdr-agents-sidebar/archive/refs/heads/main.tar.gz}
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "$tarball" | tar -xz -C "$tmp" --strip-components 1
  [ -f "$tmp/scripts/install.py" ] || { echo "Couldn't fetch the sidebar from $tarball" >&2; exit 1; }
  here=$tmp
fi

python3 "$here/scripts/install.py" "$@"
