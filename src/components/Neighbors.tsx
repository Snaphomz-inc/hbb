import type maplibregl from "maplibre-gl";
import { LngLat } from "maplibre-gl";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { distanceM } from "../lib/geo";
import { phone, screenPoint } from "../map/MapScene";
import type { IndexEntry } from "../types";

type Placed = { slug: string; name: string; w: number; arrow: string; near: boolean; onScreen: boolean };
type Rect = { x0: number; y0: number; x1: number; y1: number };

/** Arrow glyphs by screen direction, 45° steps clockwise from "to the right" (screen y points down). */
const ARROWS = ["→", "↘", "↓", "↙", "←", "↖", "↑", "↗"];
const HEIGHT = 40;
const PAD = 14;

function overlaps(a: Rect, b: Rect): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

function pillWidth(name: string): number {
  return Math.round(Math.max(name.length * 7.4, 76) + 46);
}

/**
 * The neighborhoods next door, pinned to where they lie: over their centre while it is in view,
 * otherwise against the edge of the screen in their direction, the way a game marks what is off
 * screen. A click flies there. Pills that would land on the story's text, or on each other, stay
 * hidden.
 *
 * Positions are written straight to the DOM inside the map's move event, like the fact labels, so
 * they keep up with a drag or a wheel zoom; React only renders when a pill's state changes.
 */
export function Neighbors({
  map,
  index,
  current,
  onPick,
  onHold,
  hidden,
}: {
  map: maplibregl.Map;
  index: IndexEntry[];
  current: string;
  onPick: (slug: string) => void;
  /** The pointer is over a pill: the camera should hold still so the pill stays under it. */
  onHold: (held: boolean) => void;
  hidden: boolean;
}) {
  const neighbors = useMemo(() => {
    const here = index.find((entry) => entry.slug === current);
    if (!here) return [];
    return index
      .filter((entry) => entry.slug !== current)
      .sort((a, b) => distanceM(here.center, a.center) - distanceM(here.center, b.center))
      .slice(0, phone() ? 3 : 6);
  }, [index, current]);
  const [placed, setPlaced] = useState<Placed[]>([]);
  const nodes = useRef(new Map<string, HTMLElement>());
  const positions = useRef(new Map<string, { x: number; y: number }>());

  const applyPositions = () => {
    for (const [slug, at] of positions.current) {
      const node = nodes.current.get(slug);
      if (node) node.style.transform = `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px)`;
    }
  };
  useLayoutEffect(applyPositions);

  useEffect(() => {
    if (neighbors.length === 0) {
      setPlaced([]);
      positions.current.clear();
      return;
    }
    let signature = "";
    let blocked: Rect[] = [];
    let measuredAt = 0;
    // Whether each pill sat over its centre last time: a pill near the edge of the view would otherwise
    // flip between its centre and the edge on every small camera move, which reads as a glitch.
    const wasNear = new Map<string, boolean>();
    const update = () => {
      const width = map.getContainer().clientWidth;
      const height = map.getContainer().clientHeight;
      const wide = width > 900;
      // Where a pill's centre may sit: inside the edges, under the header, above the bottom chrome.
      const edge = { x0: PAD, x1: width - PAD, y0: wide ? 84 : 72, y1: height - (wide ? 76 : 110) };
      // Text on screen right now: the hero, the chapter's headline block and stats, the closing, the
      // question. Measured a few times a second, not on every move.
      const now = performance.now();
      if (now - measuredAt > 250) {
        measuredAt = now;
        blocked = [...document.querySelectorAll(".hero.show > *, .story.show > *, .closing.show > *, .question-wrap.show > *")]
          .map((element) => element.getBoundingClientRect())
          .filter((r) => r.width > 0 && r.height > 0)
          .map((r) => ({ x0: r.left - 6, y0: r.top - 6, x1: r.right + 6, y1: r.bottom + 6 }));
      }
      const centre = map.getCenter();
      const bearing = (map.getBearing() * Math.PI) / 180;
      const cx = width / 2;
      const cy = height / 2;
      const taken: Rect[] = [];
      const next: Placed[] = neighbors.map((entry) => {
        const w = pillWidth(entry.name);
        const point = screenPoint(map, entry.center);
        const finite = Number.isFinite(point.x) && Number.isFinite(point.y);
        const inside = (margin: number) =>
          finite && point.x > edge.x0 + w / 2 + margin && point.x < edge.x1 - w / 2 - margin && point.y > edge.y0 + HEIGHT + margin && point.y < edge.y1 - margin;
        // A pill settles over its centre only where the projection is trustworthy: a point behind the
        // camera, or past the horizon on a steep pitch, projects somewhere meaningless. The check goes
        // out and back through the transform's own flat-ground maths (map.unproject on a terrain map
        // reads a pixel back from the GPU and stalls the frame). Settling takes a clear margin inside
        // the view; once settled, a pill stays while its point is inside, and only leaves by stepping
        // well past the edge.
        let near: boolean;
        if (wasNear.get(entry.slug)) {
          near = inside(-10);
        } else if (inside(28)) {
          const flat = map.transform.locationToScreenPoint(LngLat.convert(entry.center));
          const back = Number.isFinite(flat.x) && Number.isFinite(flat.y) ? map.transform.screenPointToLocation(flat) : null;
          near = back !== null && distanceM([back.lng, back.lat], entry.center) < 400;
        } else {
          near = false;
        }
        wasNear.set(entry.slug, near);
        let x: number;
        let y: number;
        let arrow = "";
        // Along which axis an edge pill may slide to clear another pill: x along the top and bottom
        // edges, y along the sides; a pill over its centre does not slide.
        let slide: "x" | "y" | null = null;
        if (near) {
          x = point.x - w / 2;
          y = point.y - HEIGHT - 10;
        } else {
          // Off screen: aim from the middle of the view along the ground direction, turned by the map's bearing.
          const east = (entry.center[0] - centre.lng) * Math.cos((centre.lat * Math.PI) / 180);
          const north = entry.center[1] - centre.lat;
          const dx = east * Math.cos(bearing) - north * Math.sin(bearing);
          const dy = -(east * Math.sin(bearing) + north * Math.cos(bearing));
          const box = { x0: edge.x0 + w / 2, x1: edge.x1 - w / 2, y0: edge.y0 + HEIGHT / 2, y1: edge.y1 - HEIGHT / 2 };
          const tx = dx > 0 ? (box.x1 - cx) / dx : dx < 0 ? (box.x0 - cx) / dx : Infinity;
          const ty = dy > 0 ? (box.y1 - cy) / dy : dy < 0 ? (box.y0 - cy) / dy : Infinity;
          const t = Math.max(0, Math.min(tx, ty));
          x = cx + dx * t - w / 2;
          y = cy + dy * t - HEIGHT / 2;
          slide = tx < ty ? "y" : "x";
          const angle = Math.atan2(dy, dx);
          arrow = ARROWS[((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8];
        }
        let rect = { x0: x, y0: y, x1: x + w, y1: y + HEIGHT };
        // Two neighbours in nearly the same direction land on the same edge spot; the later one slides
        // along the edge past the other rather than blinking in and out as the camera drifts.
        if (slide) {
          for (let attempt = 0; attempt < 4; attempt += 1) {
            const other = taken.find((o) => overlaps(rect, o)) ?? blocked.find((o) => overlaps(rect, o));
            if (!other) break;
            if (slide === "x") {
              const away = x + w / 2 < (other.x0 + other.x1) / 2 ? -1 : 1;
              x = away < 0 ? other.x0 - w - 8 : other.x1 + 8;
              x = Math.min(Math.max(x, edge.x0), edge.x1 - w);
            } else {
              const away = y + HEIGHT / 2 < (other.y0 + other.y1) / 2 ? -1 : 1;
              y = away < 0 ? other.y0 - HEIGHT - 8 : other.y1 + 8;
              y = Math.min(Math.max(y, edge.y0), edge.y1 - HEIGHT);
            }
            rect = { x0: x, y0: y, x1: x + w, y1: y + HEIGHT };
          }
        }
        const onScreen = !blocked.some((zone) => overlaps(rect, zone)) && !taken.some((other) => overlaps(rect, other));
        if (onScreen) taken.push(rect);
        positions.current.set(entry.slug, { x, y });
        return { slug: entry.slug, name: entry.name, w, arrow, near, onScreen };
      });
      applyPositions();
      const nextSignature = next.map((p) => `${p.slug}:${p.arrow}:${p.near ? 1 : 0}:${p.onScreen ? 1 : 0}`).join("|");
      if (nextSignature !== signature) {
        signature = nextSignature;
        setPlaced(next);
      }
    };
    positions.current.clear();
    update();
    map.on("move", update);
    map.on("resize", update);
    // The text blocks fade in and out with the chapters; look again as that settles.
    const interval = window.setInterval(update, 400);
    return () => {
      window.clearInterval(interval);
      map.off("move", update);
      map.off("resize", update);
    };
  }, [map, neighbors]);

  return (
    <div className="neighbors" aria-hidden={hidden}>
      {placed.map((pill) => (
        <button
          key={pill.slug}
          ref={(node) => {
            if (node) nodes.current.set(pill.slug, node);
            else nodes.current.delete(pill.slug);
          }}
          type="button"
          className={`neighbor ${pill.near ? "neighbor-near" : ""} ${!hidden && pill.onScreen ? "in" : ""}`}
          style={{ width: pill.w }}
          onClick={() => onPick(pill.slug)}
          onMouseEnter={() => onHold(true)}
          onMouseLeave={() => onHold(false)}
          title={`Fly to ${pill.name}`}
        >
          <span className="neighbor-arrow" aria-hidden="true">{pill.near ? "•" : pill.arrow}</span>
          <span className="neighbor-text">
            <span className="neighbor-name">{pill.name}</span>
            <span className="neighbor-go">view its story →</span>
          </span>
        </button>
      ))}
    </div>
  );
}
