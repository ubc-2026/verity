// Copies Astryx's pre-compiled CSS without its @layer wrapper, so its class rules beat the page's
// unlayered element styles (h2, p, button...) inside the pop-up. All Astryx selectors are class-scoped.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
let c = readFileSync('node_modules/@astryxdesign/core/dist/astryx.css', 'utf8');
c = c.replace('@layer reset, astryx-base, astryx-theme;', '');
const i = c.indexOf('@layer astryx-base {');
let depth = 0, end = -1;
for (let k = c.indexOf('{', i); k < c.length; k++) { if (c[k] === '{') depth++; else if (c[k] === '}' && --depth === 0) { end = k; break; } }
c = c.slice(0, i) + c.slice(c.indexOf('{', i) + 1, end) + c.slice(end + 1);
if (c.includes('@layer')) throw new Error('unexpected @layer left');
mkdirSync('out', { recursive: true });
writeFileSync('out/astryx.css', '/*! @astryxdesign/core pre-compiled CSS (MIT, Meta Platforms, Inc.), unlayered for the Verity pop-up. */\n' + c);
