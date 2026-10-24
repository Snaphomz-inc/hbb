import type maplibregl from "maplibre-gl";
import { useEffect, useState, type MutableRefObject } from "react";
import { money } from "../lib/format";
import { listingUrl } from "../links";
import { screenPoint } from "../map/MapScene";

/** A sale whose card is shown without a hover, to show that the dots are links. */
export type Teaser = { id: number; lon: number; lat: number; price: number; beds: number; sqft: number; kind: number; listing: string; address: string };

type Placed = Teaser & { x: number; y: number; onScreen: boolean };

/** Where each card's dot sits on the page right now, for the map's own hit test. */
export type TeaserSpots = Array<{ id: number; x: number; y: number }>;

export function saleKindName(kind: number): string {
  return kind === 0 ? "house" : kind === 1 ? "condo" : "home";
}

/**
 * One or two sale dots carry their listing card from the moment they land, as a hint that every dot
 * opens its listing. They follow the camera every frame like the fact labels, and go away as soon
 * as the pointer finds a different dot, so the hint never competes with the real hover card.
 */
export function SaleTeasers({ map, teasers, spots }: { map: maplibregl.Map; teasers: Teaser[]; spots: MutableRefObject<TeaserSpots> }) {
  const [placed, setPlaced] = useState<Placed[]>([]);

  useEffect(() => {
    if (teasers.length === 0) {
      setPlaced([]);
      spots.current = [];
      return;
    }
    let frame = 0;
    const update = () => {
      const rect = map.getCanvas().getBoundingClientRect();
      const width = map.getContainer().clientWidth;
      const height = map.getContainer().clientHeight;
      const next = teasers.map((teaser) => {
        const point = screenPoint(map, [teaser.lon, teaser.lat]);
        const onScreen = Number.isFinite(point.x) && Number.isFinite(point.y) && point.x > 90 && point.x < width - 90 && point.y > 120 && point.y < height - 40;
        return { ...teaser, x: rect.left + point.x, y: rect.top + point.y, onScreen };
      });
      spots.current = next.map((t) => ({ id: t.id, x: t.x, y: t.y }));
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
  }, [map, teasers, spots]);

  return (
    <>
      {placed.map((teaser) => (
        <a
          key={teaser.id}
          className={`sale-tip is-teaser ${teaser.onScreen ? "show" : ""}`}
          style={{ left: teaser.x, top: teaser.y }}
          href={listingUrl(teaser.listing)}
          target="_blank"
          rel="noreferrer"
          title="Open the listing on Snaphomz"
        >
          <div className="sale-tip-price">{money(teaser.price)}</div>
          {teaser.address && <div className="sale-tip-address">{teaser.address}</div>}
          <div className="sale-tip-meta">
            {teaser.beds > 0 ? `${teaser.beds} bd · ` : ""}
            {teaser.sqft > 0 ? `${teaser.sqft.toLocaleString()} sqft · ` : ""}
            {saleKindName(teaser.kind)}
          </div>
          <div className="sale-tip-hint">Open the listing on Snaphomz ↗</div>
        </a>
      ))}
    </>
  );
}
