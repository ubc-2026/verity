#!/bin/sh
# Assembles the single-file site from src/. Output: dist/index.html
set -e
cd "$(dirname "$0")"
mkdir -p dist
{
cat <<'HEAD'
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Verity: prediction-market resolution risk and verifiable agent payments</title>
<meta name="description" content="Verity reads how a prediction market settles, scores the resolution risk, buys only the evidence that closes a gap through request-bound USDC payments, and reconciles payment against delivery. UBC 2026 prototype, testnet only.">
<meta name="theme-color" content="#090C10">
<meta property="og:title" content="Verity">
<meta property="og:description" content="Separate “will it happen?” from “how does it resolve?”">
<meta property="og:type" content="website">
<meta property="og:url" content="https://verityresearch.us/">
<link rel="canonical" href="https://verityresearch.us/">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect width='24' height='24' rx='5' fill='%23090C10'/%3E%3Cpath d='M3 4h4.2L12 15.6 16.8 4H21l-7.4 16h-3.2z' fill='%23F1F5F9'/%3E%3Cpath d='M10.4 20h3.2l1.3-2.9H9.1z' fill='%232E5CFF'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="preconnect" href="https://cdnjs.cloudflare.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
HEAD
cat src/style.css
echo '</style>'
echo '</head>'
echo '<body>'
cat src/body.html
echo '<script>'
cat keccak.js
cat src/app1.js src/live.js src/ticker.js src/app2.js src/gemini.js src/news.js src/app3.js
echo '</script>'
echo '</body>'
echo '</html>'
} > dist/index.html
wc -c dist/index.html
