#!/bin/sh
# mausbridge: build ~/Desktop/OpenMausBot.app, a double-click wrapper around launch-desktop.sh.
# Re-run after moving the checkout. Usage: scripts/mausbridge/make-launcher.sh [target.app]
set -e
repo=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)
target=${1:-"$HOME/Desktop/OpenMausBot.app"}
script=$(mktemp -t omb-launcher).applescript
printf 'do shell script quoted form of "%s/scripts/mausbridge/launch-desktop.sh" & " > /dev/null 2>&1 &"\n' "$repo" > "$script"
osacompile -o "$target" "$script"
rm -f "$script"
cp "$repo/build/icon.icns" "$target/Contents/Resources/applet.icns"
touch "$target"
echo "made $target"
