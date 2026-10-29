import type maplibregl from "maplibre-gl";
import { useEffect, useMemo, useState } from "react";
import { distanceM } from "../lib/geo";
import { phone, screenPoint } from "../map/MapScene";
import type { IndexEntry } from "../types";

type Placed = { slug: string; name: string; x: number; y: number; w: number; arrow: string; near: boolean; onScreen: boolean };
type Rect = { x0: number; y0: number; x1: number; y1: number };

/** Arrow glyphs by screen direction, 45° steps clockwise from "to the right" (screen y points down). */
const ARROWS = ["→", "↘", "↓", "↙", "←", "↖", "↑", "↗"];
const HEIGHT = 30;
const PAD = 14;

function overlaps(a: Rect, b: Rect): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

function pillWidth(name: string): number {
  return Math.round(name.length * 7.4 + 44);
}

/**
 * The neighborhoods next door, pinned to where they lie: over their centre while it is in view,
 * otherwise against the edge of the screen in their direction, the way a game marks what is off
 * screen. They follow the camera every frame, so they stay honest in free look, and a click flies
 * there. Pills that would land on the story's text, or on each other, stay hidden.
 */
export function Neighbors({ map, index, current, onPick, hidden }: { map: maplibregl.Map; index: IndexEntry[]; current: string; onPick: (slug: string) => void; hidden: boolean }) {
  const neighbors = useMemo(() => {
    const here = index.find((entry) => entry.slug === current);
    if (!here) return [];
    return index
      .filter((entry) => entry.slug !== current)
      .sort((a, b) => distanceM(here.center, a.center) - distanceM(here.center, b.center))
      .slice(0, phone() ? 3 : 6);
  }, [index, current]);
  const [placed, setPlaced] = useState<Placed[]>([]);

  useEffect(() => {
    if (neighbors.length === 0) {
      setPlaced([]);
      return;
    }
    let frame = 0;
    const update = () => {
      const width = map.getContainer().clientWidth;
      const height = map.getContainer().clientHeight;
      const wide = width > 900;
      // Where a pill's centre may sit: inside the edges, under the header, above the bottom chrome.
      const edge = { x0: PAD, x1: width - PAD, y0: wide ? 84 : 72, y1: height - (wide ? 70 : 110) };
      // Text on screen right now: the hero, the chapter's headline block and stats, the closing, the question.
      const blocked: Rect[] = [...document.querySelectorAll(".hero.show > *, .story.show > *, .closing.show > *, .question-wrap.show > *")]
        .map((element) => element.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0)
        .map((r) => ({ x0: r.left - 6, y0: r.top - 6, x1: r.right + 6, y1: r.bottom + 6 }));
      const centre = map.getCenter();
      const bearing = (map.getBearing() * Math.PI) / 180;
      const cx = width / 2;
      const cy = height / 2;
      const taken: Rect[] = [];
      const next: Placed[] = neighbors.map((entry) => {
        const w = pillWidth(entry.name);
        const point = screenPoint(map, entry.center);
        // The projection is only trusted where it lands back on the same ground: a point behind the
        // camera, or past the horizon on a steep pitch, projects somewhere meaningless.
        const finite = Number.isFinite(point.x) && Number.isFinite(point.y);
        const back = finite ? map.unproject([point.x, point.y]) : null;
        const trusted = back !== null && distanceM([back.lng, back.lat], entry.center) < 400;
        const near = trusted && point.x > edge.x0 + w / 2 && point.x < edge.x1 - w / 2 && point.y > edge.y0 + HEIGHT && point.y < edge.y1;
        let x: number;
        let y: number;
        let arrow = "";
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
          const angle = Math.atan2(dy, dx);
          arrow = ARROWS[((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8];
        }
        const rect = { x0: x, y0: y, x1: x + w, y1: y + HEIGHT };
        const onScreen = !blocked.some((zone) => overlaps(rect, zone)) && !taken.some((other) => overlaps(rect, other));
        if (onScreen) taken.push(rect);
        return { slug: entry.slug, name: entry.name, x, y, w, arrow, near, onScreen };
      });
      setPlaced(next);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    update();
    map.on("move", schedule);
    map.on("resize", schedule);
    // The text blocks fade in and out with the chapters; look again as that settles.
    const interval = window.setInterval(schedule, 400);
    return () => {
      cancelAnimationFrame(frame);
      window.clearInterval(interval);
      map.off("move", schedule);
      map.off("resize", schedule);
    };
  }, [map, neighbors]);

  return (
    <div className="neighbors" aria-hidden={hidden}>
      {placed.map((pill) => (
        <button
          key={pill.slug}
          type="button"
          className={`neighbor ${pill.near ? "neighbor-near" : ""} ${!hidden && pill.onScreen ? "in" : ""}`}
          style={{ transform: `translate(${Math.round(pill.x)}px, ${Math.round(pill.y)}px)`, width: pill.w }}
          onClick={() => onPick(pill.slug)}
          title={`Fly to ${pill.name}`}
        >
          <span className="neighbor-arrow" aria-hidden="true">{pill.near ? "•" : pill.arrow}</span>
          <span className="neighbor-name">{pill.name}</span>
        </button>
      ))}
    </div>
  );
}
