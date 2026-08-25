#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

npm install

DEST="$ROOT/vendor/ffmpeg"
mkdir -p "$DEST"

cp node_modules/@ffmpeg/ffmpeg/dist/umd/ffmpeg.js "$DEST/"
cp node_modules/@ffmpeg/ffmpeg/dist/umd/814.ffmpeg.js "$DEST/"
cp node_modules/@ffmpeg/util/dist/umd/index.js "$DEST/util.js"
cp node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.js "$DEST/"
cp node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.wasm "$DEST/"

echo "Vendor files copied to $DEST:"
ls -lh "$DEST"
