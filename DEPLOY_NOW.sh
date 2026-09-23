#!/bin/bash
# Complete Cloudflare Pages deploy for PixelGame.
# Run this in Terminal.app (not Cursor) so OAuth can finish.
set -euo pipefail
cd "$(dirname "$0")"

echo "==> 1/4 Checking Cloudflare login…"
if ! npx wrangler@3.114.3 whoami >/dev/null 2>&1; then
  echo "Not logged in. A browser window will open — click Allow."
  npx wrangler@3.114.3 login
fi
npx wrangler@3.114.3 whoami

echo
echo "==> 2/4 Building (Vite + prerender + sitemap)…"
npm run build

echo
echo "==> 3/4 Uploading dist/ to Cloudflare Pages project 'pixelgame'…"
npx wrangler@3.114.3 pages deploy dist --project-name=pixelgame --commit-dirty=true

echo
echo "==> 4/4 Done."
echo "Dashboard: https://dash.cloudflare.com/?to=/:account/workers-and-pages"
echo "Look under Workers & Pages → Pages (not only Workers)."
echo "Live URL should be: https://pixelgame.pages.dev"
echo
echo "Attach pixelgame.games:"
echo "  Workers & Pages → pixelgame → Custom domains → Add pixelgame.games"
