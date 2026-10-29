import type maplibregl from "maplibre-gl";
import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import { money } from "../lib/format";
import { listingUrl } from "../links";
import { screenPoint } from "../map/MapScene";

/** A sale whose card is shown without a hover, to show that the dots are links. */
export type Teaser = { id: number; lon: number; lat: number; price: number; beds: number; sqft: number; kind: number; listing: string; address: string };

type Placed = Teaser & { onScreen: boolean };

/** Where each card's dot sits on the page right now, for the map's own hit test. */
export type TeaserSpots = Array<{ id: number; x: number; y: number }>;

export function saleKindName(kind: number): string {
  return kind === 0 ? "house" : kind === 1 ? "condo" : "home";
}

/**
 * One or two sale dots carry their listing card from the moment they land, as a hint that every dot
 * opens its listing. They follow the camera like the fact labels (positions written straight to the
 * DOM inside the map's move event), and go away as soon as the pointer finds a different dot, so
 * the hint never competes with the real hover card.
 */
export function SaleTeasers({ map, teasers, spots }: { map: maplibregl.Map; teasers: Teaser[]; spots: MutableRefObject<TeaserSpots> }) {
  const [placed, setPlaced] = useState<Placed[]>([]);
  const nodes = useRef(new Map<number, HTMLElement>());
  const positions = useRef(new Map<number, { x: number; y: number }>());

  const applyPositions = () => {
    for (const [id, at] of positions.current) {
      const node = nodes.current.get(id);
      if (node) {
        node.style.left = `${at.x}px`;
        node.style.top = `${at.y}px`;
      }
    }
  };
  useLayoutEffect(applyPositions);

  useEffect(() => {
    if (teasers.length === 0) {
      setPlaced([]);
      spots.current = [];
      positions.current.clear();
      return;
    }
    let signature = "";
    const update = () => {
      const rect = map.getCanvas().getBoundingClientRect();
      const width = map.getContainer().clientWidth;
      const height = map.getContainer().clientHeight;
      const next = teasers.map((teaser) => {
        const point = screenPoint(map, [teaser.lon, teaser.lat]);
        const onScreen = Number.isFinite(point.x) && Number.isFinite(point.y) && point.x > 90 && point.x < width - 90 && point.y > 120 && point.y < height - 40;
        positions.current.set(teaser.id, { x: rect.left + point.x, y: rect.top + point.y });
        return { ...teaser, onScreen };
      });
      spots.current = next.map((t) => ({ id: t.id, ...positions.current.get(t.id)! }));
      applyPositions();
      const nextSignature = next.map((t) => `${t.id}:${t.onScreen ? 1 : 0}`).join("|");
      if (nextSignature !== signature) {
        signature = nextSignature;
        setPlaced(next);
      }
    };
    positions.current.clear();
    update();
    map.on("move", update);
    map.on("resize", update);
    return () => {
      map.off("move", update);
      map.off("resize", update);
    };
  }, [map, teasers, spots]);

  return (
    <>
      {placed.map((teaser) => {
        const card = (
          <>
            <div className="sale-tip-price">{money(teaser.price)}</div>
            {teaser.address && <div className="sale-tip-address">{teaser.address}</div>}
            <div className="sale-tip-meta">
              {teaser.beds > 0 ? `${teaser.beds} bd · ` : ""}
              {teaser.sqft > 0 ? `${teaser.sqft.toLocaleString()} sqft · ` : ""}
              {saleKindName(teaser.kind)}
            </div>
            {teaser.listing && <div className="sale-tip-hint">Open the listing on Snaphomz ↗</div>}
          </>
        );
        const className = `sale-tip is-teaser ${teaser.onScreen ? "show" : ""}`;
        const attach = (node: HTMLElement | null) => {
          if (node) nodes.current.set(teaser.id, node);
          else nodes.current.delete(teaser.id);
        };
        // A focused sale without a listing page still gets its card, just not as a link.
        return teaser.listing ? (
          <a key={teaser.id} ref={attach} className={className} href={listingUrl(teaser.listing)} target="_blank" rel="noreferrer" title="Open the listing on Snaphomz">
            {card}
          </a>
        ) : (
          <div key={teaser.id} ref={attach} className={`${className} no-link`}>
            {card}
          </div>
        );
      })}
    </>
  );
}
