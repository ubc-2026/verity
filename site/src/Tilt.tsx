import {useRef, type ReactNode} from 'react';
import {gsap} from 'gsap';
import {useGSAP} from '@gsap/react';

gsap.registerPlugin(useGSAP);

/**
 * Tilts its content toward the pointer in 3D and slides a soft glare across it.
 * Only on devices that hover, and only when motion is welcome.
 */
export default function Tilt({children, className = '', max = 7}: {children: ReactNode; className?: string; max?: number}) {
  const ref = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const el = ref.current!;
      const glare = el.querySelector<HTMLElement>(':scope > .tilt-glare > span')!;
      const mm = gsap.matchMedia();
      mm.add('(prefers-reduced-motion: no-preference) and (hover: hover)', () => {
        gsap.set(el, {transformPerspective: 1100});
        const rx = gsap.quickTo(el, 'rotationX', {duration: 0.6, ease: 'power3.out'});
        const ry = gsap.quickTo(el, 'rotationY', {duration: 0.6, ease: 'power3.out'});
        const gx = gsap.quickTo(glare, 'xPercent', {duration: 0.6, ease: 'power3.out'});
        const gy = gsap.quickTo(glare, 'yPercent', {duration: 0.6, ease: 'power3.out'});
        const move = (e: PointerEvent) => {
          const r = el.getBoundingClientRect();
          const x = (e.clientX - r.left) / r.width - 0.5;
          const y = (e.clientY - r.top) / r.height - 0.5;
          ry(x * max * 2);
          rx(-y * max * 2);
          gx(x * 60);
          gy(y * 60);
          gsap.to(glare, {opacity: 1, duration: 0.3, overwrite: 'auto'});
        };
        const leave = () => {
          rx(0);
          ry(0);
          gsap.to(glare, {opacity: 0, duration: 0.5, overwrite: 'auto'});
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerleave', leave);
        return () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerleave', leave);
        };
      });
    },
    {scope: ref},
  );

  return (
    <div ref={ref} className={`tilt ${className}`}>
      {children}
      <span className="tilt-glare" aria-hidden="true">
        <span />
      </span>
    </div>
  );
}
