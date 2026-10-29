import type maplibregl from "maplibre-gl";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { screenPoint } from "../map/MapScene";
import type { Label } from "../story/chapters";

type Placed = Label & { lift: number; onScreen: boolean; flip: boolean; shift: number };

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
 * callouts in the Ageospatial flyover. A label whose card would cover another one
 * is lifted on a longer stem, and labels that land under the headline or the stat
 * panel are hidden.
 *
 * Positions are written straight to the DOM inside the map's move event, the way
 * MapLibre's own markers do it, so they never fall behind a drag or a wheel zoom.
 * React only renders when something other than a position changes.
 */
export function Labels({ map, labels, visible }: { map: maplibregl.Map; labels: Label[]; visible: boolean }) {
  const [placed, setPlaced] = useState<Placed[]>([]);
  const nodes = useRef(new Map<string, HTMLElement>());
  const positions = useRef(new Map<string, { x: number; y: number }>());

  const applyPositions = () => {
    for (const [id, at] of positions.current) {
      const node = nodes.current.get(id);
      if (node) node.style.transform = `translate(${at.x}px, ${at.y}px)`;
    }
  };
  // Nodes that have just mounted take their position before the frame paints.
  useLayoutEffect(applyPositions);

  useEffect(() => {
    let signature = "";
    let blocked: Rect[] = [];
    let measuredAt = 0;
    const update = () => {
      const width = map.getContainer().clientWidth;
      const height = map.getContainer().clientHeight;
      const wide = width > 900;
      // Screen areas the fixed text sits on: the headline block (measured, since the legend and
      // timeline change its height) and the stat column. Measured a few times a second, not per move.
      const now = performance.now();
      if (now - measuredAt > 250) {
        measuredAt = now;
        const textBottom = (document.querySelector(".story.show .story-left")?.getBoundingClientRect().bottom ?? 0) + 8;
        blocked = wide
          ? [
              { x0: 0, y0: 0, x1: 600, y1: Math.max(250, textBottom) },
              { x0: width - 400, y0: 0, x1: width, y1: height * 0.75 },
            ]
          : [
              { x0: 0, y0: 0, x1: width, y1: Math.max(230, textBottom) },
              // the stat row and question box sit along the bottom on phones
              { x0: 0, y0: height - 290, x1: width, y1: height },
            ];
      }
      const taken: Rect[] = [];
      const next: Placed[] = [];
      // A phone's map is a sliver, so only the first few labels (they are listed by importance) get a card.
      const shown = wide ? labels : labels.slice(0, 3);
      for (const label of shown) {
        const point = screenPoint(map, [label.lon, label.lat]);
        const inView = Number.isFinite(point.x) && Number.isFinite(point.y) && point.x > 30 && point.x < width - 30 && point.y > 110 && point.y < height - 70;
        let lift = 0;
        let flip = false;
        let shift = 0;
        let rect: Rect | null = null;
        if (inView) {
          const w = Math.min(cardWidth(label), wide ? Infinity : 200);
          // A card that would run off the right edge hangs to the left of its stem instead, and one that
          // would still run off an edge slides along the stem's top until it fits.
          flip = point.x + 6 + w > width - 12;
          const natural = flip ? point.x - 6 - w : point.x + 6;
          const x0 = Math.min(Math.max(natural, 12), Math.max(12, width - 12 - w));
          shift = x0 - natural;
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
        positions.current.set(label.id, { x: point.x, y: point.y });
        next.push({ ...label, lift, onScreen, flip, shift });
      }
      applyPositions();
      const nextSignature = next.map((l) => `${l.id}:${l.lift}:${l.onScreen ? 1 : 0}:${l.flip ? 1 : 0}:${Math.round(l.shift)}`).join("|");
      if (nextSignature !== signature) {
        signature = nextSignature;
        setPlaced(next);
      }
    };
    positions.current.clear();
    update();
    map.on("move", update);
    map.on("resize", update);
    // The text block fades in and out with the chapters; look again as that settles.
    const interval = window.setInterval(update, 400);
    return () => {
      window.clearInterval(interval);
      map.off("move", update);
      map.off("resize", update);
    };
  }, [map, labels]);

  return (
    <div className="labels" aria-hidden={!visible}>
      {placed.map((label, index) => (
        <div
          key={label.id}
          ref={(node) => {
            if (node) nodes.current.set(label.id, node);
            else nodes.current.delete(label.id);
          }}
          className={`label tone-${label.tone ?? "white"} ${label.flip ? "label-flip" : ""} ${visible && label.onScreen ? "in" : ""}`}
          style={{
            transitionDelay: visible ? `${index * 90}ms` : "0ms",
            ["--stem" as string]: `${STEM + label.lift}px`,
            ["--shift" as string]: `${label.shift}px`,
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
