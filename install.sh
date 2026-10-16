#!/usr/bin/env bash
set -euo pipefail

UUID="sandman@pmnelx.github.io"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${HOME}/.local/share/gnome-shell/extensions/${UUID}"

mkdir -p "${DEST}"
for d in lib icons schemas; do
    rm -rf "${DEST:?}/${d}"
done
cp -r "${SRC}/extension.js" "${SRC}/metadata.json" "${SRC}/lib" "${SRC}/icons" "${SRC}/schemas" "${DEST}/"
glib-compile-schemas "${DEST}/schemas"

if [[ "${1:-}" == "--system" ]]; then
    sudo install -D -o root -g root -m 0755 "${SRC}/sandman-configure-hibernate" /usr/local/libexec/sandman-configure-hibernate
    sudo install -D -m 0644 "${SRC}/polkit/io.github.pmnelx.sandman.policy" /usr/share/polkit-1/actions/io.github.pmnelx.sandman.policy
    echo "Installed the hibernate helper and polkit policy."
fi

echo "Installed to ${DEST}"
echo "Next steps:"
echo "  1. Log out and back in (required on Wayland)."
echo "  2. gnome-extensions enable ${UUID}"
if [[ "${1:-}" != "--system" ]]; then
    echo "  3. ./install.sh --system   (for hibernate support)"
fi
