import {useEffect, useRef, useState} from 'react';
import * as THREE from 'three';
import {RoomEnvironment} from 'three/examples/jsm/environments/RoomEnvironment.js';
import {gsap} from 'gsap';
import {ScrollTrigger} from 'gsap/ScrollTrigger';
import Coin from './Coin';
import {canMakeWebGL, fontsReady, resolveColor, tokenColor} from './three/color';

gsap.registerPlugin(ScrollTrigger);

const FACES = {
  front: {label: 'Heads: the price', big: '56¢', bigPx: 240, line: ['What the market thinks', 'will happen'], foot: 'NYC high, 62 to 63°F'},
  back: {label: 'Tails: the rules', big: 'Medium', bigPx: 150, line: ['Whether it pays out', 'the way you expect'], foot: 'Risk score 8 of 12'},
} as const;
type Side = keyof typeof FACES;

const R = 1; // coin radius
const H = 0.075; // half thickness
const R_IN = 0.835; // inner disc radius
const FACE_Z = H - 0.006;
const CANVAS_W = 2.3; // canvas size in coin diameters
const CANVAS_H = 1.75;

/**
 * Paint one face. `mode: 'bump'` paints the same marks white on black so the
 * lettering, rings and guilloche band stand up from the metal.
 */
function paintFace(side: Side, mode: 'color' | 'bump'): HTMLCanvasElement {
  const f = FACES[side];
  const S = 1024;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  const mid = S / 2;
  const bump = mode === 'bump';
  const ink = bump ? '#fff' : resolveColor('var(--coin-text)');
  const [hi, base, lo] =
    side === 'front'
      ? ['var(--coin-brass-hi)', 'var(--coin-brass)', 'var(--coin-brass-lo)']
      : ['var(--coin-steel-hi)', 'var(--coin-steel)', 'var(--coin-steel-lo)'];

  if (bump) {
    g.fillStyle = '#000';
    g.fillRect(0, 0, S, S);
  } else {
    const rg = g.createRadialGradient(mid * 0.7, mid * 0.6, 40, mid, mid, mid);
    rg.addColorStop(0, resolveColor(hi));
    rg.addColorStop(0.55, resolveColor(base));
    rg.addColorStop(1, resolveColor(lo));
    g.fillStyle = rg;
    g.fillRect(0, 0, S, S);
    // A brushed-metal sheen: fine concentric lathe marks.
    g.globalAlpha = 0.06;
    g.strokeStyle = ink;
    for (let r = 20; r < mid; r += 5) {
      g.beginPath();
      g.arc(mid, mid, r, 0, Math.PI * 2);
      g.lineWidth = (r * 7) % 3 > 1.5 ? 1 : 0.5;
      g.stroke();
    }
    g.globalAlpha = 1;
  }

  // Engraved guilloche band, like the border of a banknote.
  g.strokeStyle = ink;
  g.globalAlpha = bump ? 0.9 : 0.32;
  g.lineWidth = bump ? 2.4 : 1.6;
  for (let k = 0; k < 4; k++) {
    g.beginPath();
    for (let i = 0; i <= 720; i++) {
      const a = (i / 720) * Math.PI * 2;
      const r = 438 + 24 * Math.sin(a * 28 + (k * Math.PI) / 2);
      const x = mid + r * Math.cos(a);
      const y = mid + r * Math.sin(a);
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    }
    g.stroke();
  }
  g.globalAlpha = bump ? 1 : 0.55;
  g.lineWidth = bump ? 5 : 3;
  for (const r of [395, 488]) {
    g.beginPath();
    g.arc(mid, mid, r, 0, Math.PI * 2);
    g.stroke();
  }
  g.globalAlpha = 1;

  // Lettering.
  g.fillStyle = ink;
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.font = '500 50px "IBM Plex Mono", ui-monospace, monospace';
  g.fillText(f.label, mid, 285);
  g.font = `800 ${f.bigPx}px Archivo, ui-sans-serif, system-ui, sans-serif`;
  g.fillText(f.big, mid, side === 'front' ? 535 : 515);
  g.font = '500 50px "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif';
  f.line.forEach((l, i) => g.fillText(l, mid, 615 + i * 60));
  g.font = '500 42px "IBM Plex Mono", ui-monospace, monospace';
  g.fillText(f.foot, mid, 778);
  return c;
}

function reedTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 4;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, 1024, 4);
  g.fillStyle = '#fff';
  for (let i = 0; i < 180; i++) g.fillRect((i * 1024) / 180, 0, 2.6, 4);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

function buildCoin(maxAniso: number) {
  const group = new THREE.Group();
  const brass = tokenColor('var(--coin-brass)');
  const reed = reedTexture();
  const edgeMat = new THREE.MeshPhysicalMaterial({color: brass, metalness: 1, roughness: 0.3, bumpMap: reed, bumpScale: 2.5});
  const rimMat = new THREE.MeshPhysicalMaterial({color: brass, metalness: 1, roughness: 0.18, clearcoat: 0.5, side: THREE.DoubleSide});

  const edge = new THREE.Mesh(new THREE.CylinderGeometry(R, R, H * 2, 220, 1, true).rotateX(Math.PI / 2), edgeMat);
  group.add(edge);

  // Raised rim, turned on a lathe.
  const profile = [
    [R_IN - 0.004, FACE_Z],
    [R_IN + 0.012, H + 0.026],
    [R_IN + 0.04, H + 0.036],
    [0.95, H + 0.036],
    [0.985, H + 0.026],
    [R, H],
  ];
  const front = profile.map(([x, y]) => new THREE.Vector2(x, y));
  const back = profile.map(([x, y]) => new THREE.Vector2(x, -y)).reverse();
  for (const pts of [front, back]) group.add(new THREE.Mesh(new THREE.LatheGeometry(pts, 220).rotateX(Math.PI / 2), rimMat));

  const textures: THREE.Texture[] = [reed];
  const faces: THREE.Mesh[] = [];
  (['front', 'back'] as Side[]).forEach((side) => {
    const map = new THREE.CanvasTexture(paintFace(side, 'color'));
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = maxAniso;
    const bumpMap = new THREE.CanvasTexture(paintFace(side, 'bump'));
    textures.push(map, bumpMap);
    const mat = new THREE.MeshPhysicalMaterial({
      map,
      bumpMap,
      bumpScale: 2,
      metalness: 0.8,
      roughness: 0.4,
      clearcoat: 0.7,
      clearcoatRoughness: 0.28,
    });
    const disc = new THREE.Mesh(new THREE.CircleGeometry(R_IN, 160), mat);
    if (side === 'front') disc.position.z = FACE_Z;
    else {
      disc.rotation.y = Math.PI;
      disc.position.z = -FACE_Z;
    }
    faces.push(disc);
    group.add(disc);
  });
  return {group, textures, faces};
}

/** The hero coin in real 3D. Falls back to the CSS coin without WebGL. */
export default function Coin3D() {
  const [webgl] = useState(canMakeWebGL);
  if (!webgl) return <Coin />;
  return <CoinGL />;
}

function CoinGL() {
  const stage = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [side, setSide] = useState<Side>('front');
  const sideRef = useRef<Side>('front');
  const api = useRef<{flip: () => void} | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let disposed = false;
    let cleanup = () => {};

    fontsReady(['800 200px Archivo', '500 44px "IBM Plex Sans"', '500 44px "IBM Plex Mono"']).then(() => {
      if (disposed) return;
      let renderer: THREE.WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({canvas, antialias: true, alpha: true, powerPreference: 'high-performance'});
      } catch {
        return;
      }
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.05;
      renderer.outputColorSpace = THREE.SRGBColorSpace;

      const scene = new THREE.Scene();
      const pmrem = new THREE.PMREMGenerator(renderer);
      const env = pmrem.fromScene(new RoomEnvironment(), 0.035).texture;
      scene.environment = env;

      const key = new THREE.DirectionalLight(tokenColor('var(--coin-key)'), 2.6);
      key.position.set(-3, 4, 5);
      const warm = new THREE.DirectionalLight(tokenColor('var(--coin-warm)'), 1.2);
      warm.position.set(4, 1, 3);
      const rose = new THREE.PointLight(tokenColor('var(--coin-rim)'), 22, 0, 2);
      rose.position.set(2.6, -1.6, -1.2);
      scene.add(key, warm, rose);

      const camera = new THREE.PerspectiveCamera(30, CANVAS_W / CANVAS_H, 0.1, 50);
      camera.position.z = (CANVAS_H * 2) / (2 * Math.tan(THREE.MathUtils.degToRad(15)));

      const {group: coin, textures} = buildCoin(renderer.capabilities.getMaxAnisotropy());
      const tilt = new THREE.Group();
      const float = new THREE.Group();
      tilt.add(coin);
      float.add(tilt);
      scene.add(float);

      // Everything GSAP animates lives in one plain object.
      const s = {ry: 0, y: 0, scale: 1, tx: 0, ty: 0, scroll: 0};
      let visible = true;
      let dirty = true;

      const size = () => {
        const w = button.current!.offsetWidth;
        renderer.setSize(w * CANVAS_W, w * CANVAS_H, false);
        canvas.style.width = `${w * CANVAS_W}px`;
        canvas.style.height = `${w * CANVAS_H}px`;
        dirty = true;
      };
      size();
      const ro = new ResizeObserver(size);
      ro.observe(button.current!);

      const render = () => {
        if (!visible || (!dirty && reduce)) return;
        float.position.y = s.y;
        float.scale.setScalar(s.scale);
        tilt.rotation.set(s.tx + s.scroll * 0.9, s.ty, 0);
        coin.rotation.y = THREE.MathUtils.degToRad(s.ry);
        renderer.render(scene, camera);
        dirty = false;
      };
      gsap.ticker.add(render);

      const io = new IntersectionObserver(([e]) => {
        visible = e.isIntersecting;
        dirty = true;
      });
      io.observe(stage.current!);

      const ctx = gsap.context(() => {});
      let spin: gsap.core.Timeline | null = null;
      let onMove: ((e: PointerEvent) => void) | null = null;

      if (!reduce) {
        ctx.add(() => {
          gsap.from(s, {ry: -540, scale: 0.35, duration: 1.9, ease: 'power3.out'});
          gsap.from(canvas, {opacity: 0, duration: 0.9, ease: 'power2.out'});
          gsap.to(s, {y: 0.12, duration: 2.6, ease: 'sine.inOut', yoyo: true, repeat: -1});
          gsap.to('.coin-shadow', {scaleX: 0.8, opacity: 0.4, duration: 2.6, ease: 'sine.inOut', yoyo: true, repeat: -1});
          spin = gsap
            .timeline({repeat: -1, delay: 3.4})
            .to(s, {ry: '+=180', duration: 1.5, ease: 'power2.inOut'})
            .to({}, {duration: 3.4})
            .to(s, {ry: '+=180', duration: 1.5, ease: 'power2.inOut'})
            .to({}, {duration: 3.4});
          const tx = gsap.quickTo(s, 'tx', {duration: 0.7, ease: 'power3.out'});
          const ty = gsap.quickTo(s, 'ty', {duration: 0.7, ease: 'power3.out'});
          onMove = (e: PointerEvent) => {
            const r = stage.current!.getBoundingClientRect();
            ty(((e.clientX - (r.left + r.width / 2)) / window.innerWidth) * 0.9);
            tx(((e.clientY - (r.top + r.height / 2)) / window.innerHeight) * 0.7);
          };
          window.addEventListener('pointermove', onMove);
          // Scrolling away tips the coin back and lets it sink.
          gsap.to(s, {scroll: 1, ease: 'none', scrollTrigger: {trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true}});
          gsap.to('.coin-float-wrap', {
            yPercent: 18,
            scale: 0.9,
            ease: 'none',
            scrollTrigger: {trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true},
          });
        });
      }

      api.current = {
        flip: () => {
          spin?.kill();
          spin = null;
          const next: Side = sideRef.current === 'front' ? 'back' : 'front';
          sideRef.current = next;
          setSide(next);
          const target = (Math.round(s.ry / 180) + 1) * 180;
          if (reduce) {
            s.ry = target;
            dirty = true;
            return;
          }
          ctx.add(() => {
            gsap.killTweensOf(s, 'y');
            gsap
              .timeline()
              .to(s, {ry: target + 360, duration: 1.15, ease: 'power3.inOut'})
              .to(s, {y: 0.42, duration: 0.5, ease: 'power2.out'}, 0)
              .to(s, {y: 0, duration: 0.65, ease: 'bounce.out'}, 0.5)
              .to(s, {y: 0.12, duration: 2.6, ease: 'sine.inOut', yoyo: true, repeat: -1});
          });
        },
      };

      cleanup = () => {
        ctx.revert();
        if (onMove) window.removeEventListener('pointermove', onMove);
        gsap.ticker.remove(render);
        ro.disconnect();
        io.disconnect();
        textures.forEach((t) => t.dispose());
        coin.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            o.geometry.dispose();
            (o.material as THREE.Material).dispose();
          }
        });
        env.dispose();
        pmrem.dispose();
        renderer.dispose();
      };
    });

    return () => {
      disposed = true;
      api.current = null;
      cleanup();
    };
  }, []);

  const f = FACES[side];
  return (
    <div className="coin-stage" ref={stage}>
      <div className="coin-aura" aria-hidden="true" />
      <div className="coin-float-wrap">
        <button
          type="button"
          ref={button}
          className="coin coin-gl"
          onClick={() => api.current?.flip()}
          aria-label={side === 'back' ? 'Flip the coin to the price side' : 'Flip the coin to the rules side'}>
          <canvas ref={canvasRef} className="coin-canvas" aria-hidden="true" />
          <span className="visually-hidden" aria-live="polite">
            {f.label}: {f.big}, {f.line.join(' ')}. {f.foot}.
          </span>
        </button>
        <div className="coin-shadow" aria-hidden="true" />
      </div>
    </div>
  );
}
