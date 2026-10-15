#!/bin/sh
# Prepare the player samples (README.md): download the Cairo fonts into assets/ and build
# each sample's .ecproj from its script and props-<lang>.json (`./prepare.sh ar`: Arabic).
# Fonts only: `./prepare.sh --fonts`. CLI: $EFFECTCRAFT_CLI, else built with cargo.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
lang=${1:-fr}

# Google Fonts serves static TTF instances (PostScript names Cairo-SemiBold, -Bold, -Black, as
# the scripts select them) to clients that aren't browsers.
mkdir -p "$here/assets"
for w in 600:SemiBold 700:Bold 900:Black; do
  f="$here/assets/Cairo-${w#*:}.ttf"
  [ -s "$f" ] && continue
  url=$(curl -fsS "https://fonts.googleapis.com/css2?family=Cairo:wght@${w%%:*}" | grep -o 'https://fonts.gstatic.com/[^)]*\.ttf' | head -n 1)
  curl -fsS -o "$f" "$url"
  echo "assets/Cairo-${w#*:}.ttf"
done
[ -s "$here/assets/Cairo-OFL.txt" ] || curl -fsS -o "$here/assets/Cairo-OFL.txt" https://raw.githubusercontent.com/Gue3bara/Cairo/master/OFL.txt
[ "$lang" = "--fonts" ] && exit 0

if [ -z "${EFFECTCRAFT_CLI:-}" ]; then
  cargo build -q --release -p effectcraft-cli --manifest-path "$here/../../Cargo.toml"
  EFFECTCRAFT_CLI="$here/../../target/release/effectcraft-cli"
fi
export EFFECTCRAFT_FONT_DIRS="$here/assets"
for name in news-short; do
  # Scripts read files only under the project folder: build it in the sample's folder.
  cd "$here/$name"
  cp "props-$lang.json" props.json
  rm -f "$name.ecproj"
  "$EFFECTCRAFT_CLI" script --eval '""' --empty --save-as "$name.ecproj"
  "$EFFECTCRAFT_CLI" script "$name.jsx" --project "$name.ecproj" --save
  rm props.json
  echo "$name/$name.ecproj ($lang)"
done
