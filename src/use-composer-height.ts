import { useLayoutEffect, useRef, type RefObject } from 'react';

/** Measure only the draft; width-only observation avoids height feedback loops. */
export function useComposerHeight(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  hidden: boolean,
) {
  const measure = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    let disposed = false;
    let frame = 0;
    const resize = () => {
      if (disposed || !input.getClientRects().length) return;
      const viewport = window.visualViewport?.height ?? window.innerHeight;
      const max = Math.max(82, Math.min(320, Math.floor(viewport * 0.4)));
      input.style.setProperty('--composer-input-max-height', `${max}px`);
      const scrollTop = input.scrollTop;
      input.style.height = '0px';
      const style = getComputedStyle(input);
      const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
      input.style.height = `${Math.min(max, Math.max(82, input.scrollHeight + border))}px`;
      input.scrollTop = scrollTop;
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(resize);
    };
    measure.current = resize;
    let width = -1;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width !== width) {
        width = entry.contentRect.width;
        schedule();
      }
    });
    observer.observe(input);
    window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    document.fonts?.addEventListener('loadingdone', schedule);
    void document.fonts?.ready.then(() => {
      if (!disposed) schedule();
    });
    resize();
    return () => {
      disposed = true;
      measure.current = null;
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
      document.fonts?.removeEventListener('loadingdone', schedule);
    };
  }, [ref]);
  useLayoutEffect(() => {
    measure.current?.();
  }, [value, hidden]);
}
