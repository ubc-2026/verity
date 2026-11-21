import { copyFile } from 'node:fs/promises';
import { build } from 'esbuild';

await build({
  entryPoints: ['voice-sdk.mjs', 'voice-entry.mjs'],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  minify: true,
  outdir: '.generated',
  outExtension: { '.js': '.txt' },
});
await copyFile('node_modules/@alexanderolsen/libsamplerate-js/dist/libsamplerate.worklet.js', '.generated/voice-resampler.txt');
