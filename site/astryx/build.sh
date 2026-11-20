#!/bin/sh
# Builds the front-page market pop-up (Astryx) into ../../ (live repo) astryx/ files.
# Output: out/verity-dot.js and out/astryx.css. Copy them and out/index.html (a redirect, so /astryx/ is not a 404)
# to astryx/ in ryanmarklin-arch/verityresearch-live,
# then bump the ?v= keys in site/src/body.html (search for /astryx/) and rebuild the site.
set -e
cd "$(dirname "$0")"
npm install --no-audit --no-fund
npx esbuild dot-dialog.jsx --bundle --minify --format=iife --jsx=automatic \
  --define:process.env.NODE_ENV='"production"' --target=es2020 --legal-comments=eof --outfile=out/verity-dot.js
node unlayer-css.mjs
ls -la out
