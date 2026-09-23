#!/bin/bash
cd "$(dirname "$0")"
echo "==> Building and deploying PixelGame to Cloudflare Pages..."
npm run deploy
echo
echo "==> Done. Attach pixelgame.games in Cloudflare Dashboard if needed."
read -r -p "Press Return to close..."
