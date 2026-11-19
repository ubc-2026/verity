import {useRef, useState} from 'react';
import {gsap} from 'gsap';
import {useGSAP} from '@gsap/react';

gsap.registerPlugin(useGSAP);

const EDGE_LAYERS = 16;

/**
 * A two-sided coin: heads is the price, tails is the rules.
 * GSAP floats it, turns it with a hold on each face, tilts it toward the
 * pointer, and flips it on click.
 */
export default function Coin() {
  const stage = useRef<HTMLDivElement>(null);
  const coin = useRef<HTMLButtonElement>(null);
  const spin = useRef<gsap.core.Timeline | null>(null);
  const [side, setSide] = useState<'front' | 'back'>('front');
  const turns = useRef(0);

  useGSAP(
    () => {
      gsap.set('.coin-back', {visibility: 'hidden'});
      const mm = gsap.matchMedia();
      mm.add('(prefers-reduced-motion: no-preference)', () => {
        gsap.from(coin.current, {rotationY: -540, scale: 0.4, opacity: 0, duration: 1.8, ease: 'power3.out'});
        gsap.to('.coin-float', {y: -14, duration: 2.6, ease: 'sine.inOut', yoyo: true, repeat: -1});
        gsap.to('.coin-shadow', {scaleX: 0.82, opacity: 0.45, duration: 2.6, ease: 'sine.inOut', yoyo: true, repeat: -1});

        spin.current = gsap
          .timeline({repeat: -1, delay: 3.2})
          .to(coin.current, {rotationY: '+=180', duration: 1.4, ease: 'power2.inOut'})
          .to({}, {duration: 3.4})
          .to(coin.current, {rotationY: '+=180', duration: 1.4, ease: 'power2.inOut'})
          .to({}, {duration: 3.4});

        // Only the face turned toward the viewer is painted.
        const faces = () => {
          const r = (((Number(gsap.getProperty(coin.current, 'rotationY')) % 360) + 360) % 360);
          const front = r < 90 || r > 270;
          gsap.set('.coin-front', {visibility: front ? 'visible' : 'hidden'});
          gsap.set('.coin-back', {visibility: front ? 'hidden' : 'visible'});
        };
        gsap.ticker.add(faces);

        const tiltX = gsap.quickTo('.coin-tilt', 'rotationX', {duration: 0.6, ease: 'power3.out'});
        const tiltY = gsap.quickTo('.coin-tilt', 'rotationY', {duration: 0.6, ease: 'power3.out'});
        const move = (e: PointerEvent) => {
          const r = stage.current!.getBoundingClientRect();
          const dx = (e.clientX - (r.left + r.width / 2)) / window.innerWidth;
          const dy = (e.clientY - (r.top + r.height / 2)) / window.innerHeight;
          tiltY(dx * 34);
          tiltX(-dy * 26);
        };
        window.addEventListener('pointermove', move);

        gsap.to('.coin-float-wrap', {
          yPercent: 30,
          scale: 0.86,
          ease: 'none',
          scrollTrigger: {trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true},
        });
        return () => {
          window.removeEventListener('pointermove', move);
          gsap.ticker.remove(faces);
        };
      });
    },
    {scope: stage},
  );

  const flip = () => {
    spin.current?.kill();
    spin.current = null;
    turns.current += 1;
    const next = side === 'front' ? 'back' : 'front';
    setSide(next);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const current = Number(gsap.getProperty(coin.current, 'rotationY')) || 0;
    const target = (Math.round(current / 180) + 1) * 180;
    if (reduce) {
      gsap.set(coin.current, {rotationY: target});
      gsap.set('.coin-front', {visibility: next === 'front' ? 'visible' : 'hidden'});
      gsap.set('.coin-back', {visibility: next === 'back' ? 'visible' : 'hidden'});
      return;
    }
    gsap
      .timeline()
      .to(coin.current, {rotationY: target + 360, duration: 1.1, ease: 'power3.inOut'})
      .to('.coin-float', {y: -46, duration: 0.5, ease: 'power2.out', overwrite: true}, 0)
      .to('.coin-float', {y: 0, duration: 0.6, ease: 'bounce.out'}, 0.5)
      .to('.coin-float', {y: -14, duration: 2.6, ease: 'sine.inOut', yoyo: true, repeat: -1});
  };

  return (
    <div className="coin-stage" ref={stage}>
      <div className="coin-float-wrap">
        <div className="coin-float">
          <div className="coin-tilt">
            <button
              type="button"
              ref={coin}
              className="coin"
              onClick={flip}
              aria-label={side === 'back' ? 'Flip the coin to the price side' : 'Flip the coin to the rules side'}>
              {Array.from({length: EDGE_LAYERS}, (_, i) => (
                <span
                  key={i}
                  className="coin-edge"
                  style={{transform: `translateZ(${(i - (EDGE_LAYERS - 1) / 2) * 1.25}px)`}}
                  aria-hidden="true"
                />
              ))}
              <span className="coin-face coin-front">
                <span className="coin-ring">
                  <span className="coin-label">Heads: the price</span>
                  <span className="coin-big">56¢</span>
                  <span className="coin-line">What the market thinks will happen</span>
                  <span className="coin-foot">NYC high, 62 to 63°F</span>
                </span>
              </span>
              <span className="coin-face coin-back">
                <span className="coin-ring">
                  <span className="coin-label">Tails: the rules</span>
                  <span className="coin-big coin-big-word">Medium</span>
                  <span className="coin-line">Whether it pays out the way you expect</span>
                  <span className="coin-foot">Risk score 8 of 12</span>
                </span>
              </span>
            </button>
          </div>
        </div>
        <div className="coin-shadow" aria-hidden="true" />
      </div>
    </div>
  );
}
