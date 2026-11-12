import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

/**
 * Scroll reveal: a section rises and fades in as it enters the viewport.
 *
 * Nothing is hidden until the reader scrolls. On the first scroll, sections still below the
 * viewport (so off screen: nothing flickers) take their start state, and each reveals as it
 * enters. A page that is never scrolled (a full-page screenshot, a printout, a reader who stays
 * at the top) shows everything. With prefers-reduced-motion nothing moves (CSS, reveal.css).
 */
const registered = new Set<HTMLElement>();
let armed = false;
let observer: IntersectionObserver | null = null;

function reducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function getObserver(): IntersectionObserver {
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const el = e.target as HTMLElement;
        el.classList.remove("reveal--pending");
        observer!.unobserve(el);
      }
    },
    { threshold: 0.12, rootMargin: "0px 0px -6% 0px" },
  );
  return observer;
}

/** Hides an element that is below the viewport until it scrolls into view. */
function hold(el: HTMLElement): void {
  if (reducedMotion() || typeof IntersectionObserver === "undefined") return;
  if (el.getBoundingClientRect().top <= window.innerHeight) return;
  el.classList.add("reveal--pending");
  getObserver().observe(el);
}

function arm(): void {
  if (armed) return;
  armed = true;
  window.removeEventListener("scroll", arm);
  for (const el of registered) hold(el);
}

export function Reveal({ children, className, as: Tag = "div", delay = 0, ...rest }: { children: ReactNode; className?: string; as?: "div" | "section" | "article"; delay?: number } & Record<`aria-${string}`, string | undefined>) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    registered.add(el);
    if (armed) hold(el);
    else window.addEventListener("scroll", arm, { passive: true });
    return () => {
      registered.delete(el);
      observer?.unobserve(el);
    };
  }, []);
  return (
    <Tag ref={ref as never} className={`reveal${className ? ` ${className}` : ""}`} style={delay ? ({ "--reveal-delay": `${delay}ms` } as CSSProperties) : undefined} {...rest}>
      {children}
    </Tag>
  );
}
