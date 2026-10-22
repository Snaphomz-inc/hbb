import type maplibregl from "maplibre-gl";
import { useEffect, useState } from "react";
import type { Label } from "../story/chapters";

type Placed = Label & { x: number; y: number; lift: number; onScreen: boolean; flip: boolean };

const CARD_HEIGHT = 46;
const STEM = 34;
const LIFT_STEP = 52;

function cardWidth(label: Label): number {
  const longest = Math.max(label.title.length * 7.2, (label.value ?? "").length * 7.6);
  return longest + 26;
}

type Rect = { x0: number; y0: number; x1: number; y1: number };

function overlaps(a: Rect, b: Rect): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

/**
 * Floating fact labels pinned to map coordinates with a leader line, like the
 * callouts in the Ageospatial flyover. Positions follow the camera every frame;
 * a label whose card would cover another one is lifted on a longer stem, and
 * labels that land under the headline or the stat panel are hidden.
 */
export function Labels({ map, labels, visible }: { map: maplibregl.Map; labels: Label[]; visible: boolean }) {
  const [placed, setPlaced] = useState<Placed[]>([]);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      const width = map.getContainer().clientWidth;
      const height = map.getContainer().clientHeight;
      const wide = width > 900;
      // Screen areas the fixed text sits on: the headline block and the stat column.
      const blocked: Rect[] = wide
        ? [
            { x0: 0, y0: 0, x1: 600, y1: 250 },
            { x0: width - 400, y0: 0, x1: width, y1: height * 0.75 },
          ]
        : [
            { x0: 0, y0: 0, x1: width, y1: 230 },
            // the stat row and question box sit along the bottom on phones
            { x0: 0, y0: height - 290, x1: width, y1: height },
          ];
      const taken: Rect[] = [];
      const next: Placed[] = [];
      for (const label of labels) {
        const point = map.project([label.lon, label.lat]);
        const inView = Number.isFinite(point.x) && Number.isFinite(point.y) && point.x > 30 && point.x < width - 30 && point.y > 110 && point.y < height - 70;
        let lift = 0;
        let flip = false;
        let rect: Rect | null = null;
        if (inView) {
          const w = Math.min(cardWidth(label), wide ? Infinity : 200);
          // A card that would run off the right edge hangs to the left of its stem instead.
          flip = point.x + 6 + w > width - 12;
          const x0 = flip ? point.x - 6 - w : point.x + 6;
          for (let attempt = 0; attempt < 4; attempt += 1) {
            lift = attempt * LIFT_STEP;
            const bottom = point.y - STEM - lift;
            rect = { x0, y0: bottom - CARD_HEIGHT, x1: x0 + w, y1: bottom };
            if (!taken.some((other) => overlaps(rect!, other))) break;
          }
        }
        const underText = rect ? blocked.some((zone) => overlaps(rect!, zone)) : false;
        const onScreen = inView && !underText && rect !== null && rect.y0 > 60;
        if (onScreen && rect) taken.push(rect);
        next.push({ ...label, x: point.x, y: point.y, lift, onScreen, flip });
      }
      setPlaced(next);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    update();
    map.on("move", schedule);
    map.on("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      map.off("move", schedule);
      map.off("resize", schedule);
    };
  }, [map, labels]);

  return (
    <div className="labels" aria-hidden={!visible}>
      {placed.map((label, index) => (
        <div
          key={label.id}
          className={`label tone-${label.tone ?? "white"} ${label.flip ? "label-flip" : ""} ${visible && label.onScreen ? "in" : ""}`}
          style={{
            transform: `translate(${label.x}px, ${label.y}px)`,
            transitionDelay: visible ? `${index * 90}ms` : "0ms",
            ["--stem" as string]: `${STEM + label.lift}px`,
          }}
        >
          <span className="label-dot" />
          <span className="label-stem" />
          <span className="label-card">
            <span className="label-title">{label.title}</span>
            {label.value && <span className="label-value">{label.value}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}
