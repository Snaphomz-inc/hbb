import { useEffect, useRef, useState } from "react";

const GLYPHS = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789<>/+=*#";

/**
 * Text that decodes into place when it changes: each character flickers through
 * random glyphs and settles left to right, the way the Ageospatial headings do.
 */
export function useScramble(target: string, durationMs = 700): string {
  const [shown, setShown] = useState(target);
  const frame = useRef<number>(0);
  const previous = useRef(target);

  useEffect(() => {
    if (target === previous.current) return;
    previous.current = target;
    const started = performance.now();
    const length = target.length;
    cancelAnimationFrame(frame.current);
    const tick = (now: number) => {
      const progress = Math.min(1, (now - started) / durationMs);
      const settled = Math.floor(progress * length);
      let text = "";
      for (let index = 0; index < length; index += 1) {
        const char = target[index];
        if (index < settled || char === " " || char === "\n") text += char;
        else text += GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
      }
      setShown(text);
      if (progress < 1) frame.current = requestAnimationFrame(tick);
      else setShown(target);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [target, durationMs]);

  return shown;
}
