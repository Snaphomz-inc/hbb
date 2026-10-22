import { useEffect, useRef, useState } from "react";
import type { Chapter } from "./chapters";

export type StoryPosition = {
  /** Index of the chapter whose text and labels are on screen. */
  active: number;
  /** 0 to 1 through the active chapter's section. */
  progress: number;
  /** Continuous camera position: chapter index plus eased transition to the next. */
  cameraT: number;
  /** 0 to 1 through the whole story, for the progress bar. */
  overall: number;
};

const HOLD = 0.55;

function smoothstep(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

export function positionFor(chapters: Chapter[], scrollY: number, viewport: number): StoryPosition {
  if (chapters.length === 0) return { active: 0, progress: 0, cameraT: 0, overall: 0 };
  let start = 0;
  let total = 0;
  for (const chapter of chapters) total += chapter.height * viewport;
  // The last section only needs to be a viewport tall; the story ends when it fills the screen.
  const last = chapters.length - 1;
  for (let index = 0; index < chapters.length; index += 1) {
    const length = chapters[index].height * viewport;
    const end = start + length;
    if (scrollY < end || index === last) {
      const progress = Math.min(1, Math.max(0, (scrollY - start) / Math.max(1, length)));
      const transition = index === last ? 0 : smoothstep((progress - HOLD) / (1 - HOLD));
      const switchEarly = index < last && progress > 0.86;
      return {
        active: switchEarly ? index + 1 : index,
        progress: switchEarly ? 0 : progress,
        cameraT: index + transition,
        overall: Math.min(1, scrollY / Math.max(1, total - viewport)),
      };
    }
    start = end;
  }
  return { active: last, progress: 1, cameraT: last, overall: 1 };
}

/** Scroll position of the window, mapped onto the chapters. */
export function useScrollStory(chapters: Chapter[]): { position: StoryPosition; positionRef: React.MutableRefObject<StoryPosition> } {
  const [position, setPosition] = useState<StoryPosition>(() => positionFor(chapters, window.scrollY, window.innerHeight));
  const positionRef = useRef(position);

  useEffect(() => {
    let frame = 0;
    const read = () => {
      const next = positionFor(chapters, window.scrollY, window.innerHeight);
      positionRef.current = next;
      setPosition((current) =>
        current.active === next.active && Math.abs(current.progress - next.progress) < 0.004 && Math.abs(current.overall - next.overall) < 0.002 ? current : next,
      );
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(read);
    };
    read();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [chapters]);

  return { position, positionRef };
}
