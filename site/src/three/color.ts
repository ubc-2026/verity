import * as THREE from 'three';

/**
 * Resolve a CSS colour (a token like `var(--color-accent)`, oklch or color-mix)
 * to a string canvas understands, so every WebGL colour still comes from a token.
 */
let probe: HTMLSpanElement | null = null;
export function resolveColor(value: string): string {
  if (!probe) {
    probe = document.createElement('span');
    probe.style.display = 'none';
    document.body.appendChild(probe);
  }
  probe.style.color = '';
  probe.style.color = value;
  return getComputedStyle(probe).color;
}

let ctx: CanvasRenderingContext2D | null = null;
/** A token as a three.js colour (sRGB), read back through a 1px canvas. */
export function tokenColor(value: string): THREE.Color {
  if (!ctx) {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    ctx = c.getContext('2d', {willReadFrequently: true})!;
  }
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = '#000';
  ctx.fillStyle = resolveColor(value);
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
}

/** Wait for the page fonts canvas needs, but never longer than `ms`. */
export function fontsReady(specs: string[], ms = 2500): Promise<unknown> {
  if (!document.fonts) return Promise.resolve();
  return Promise.race([Promise.all(specs.map((s) => document.fonts.load(s))), new Promise((r) => setTimeout(r, ms))]);
}

export function canMakeWebGL(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}
