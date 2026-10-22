import maplibregl from "maplibre-gl";
import { useEffect, useMemo, useRef, useState } from "react";
import { money } from "./lib/format";
import { useScramble } from "./lib/scramble";
import { collapseAttribution, mapAlive } from "./map/MapScene";
import { baseStyle } from "./map/style";
import type { IndexEntry } from "./types";

const SOURCE = "neighborhoods";

function terciles(values: number[]): [number, number] {
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (share: number) => sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] ?? 0;
  return [pick(1 / 3), pick(2 / 3)];
}

/**
 * The front door: every neighborhood on one slow-turning map of the county,
 * coloured by median price, with the same list down the side grouped by region.
 * Click either to fly into that neighborhood's story.
 */
export function Overview({ index, onPick }: { index: IndexEntry[]; onPick: (slug: string) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const headline = useScramble("Know Los Angeles before you buy.", 900);

  const regions = useMemo(() => {
    const groups = new Map<string, IndexEntry[]>();
    for (const entry of index) groups.set(entry.region, [...(groups.get(entry.region) ?? []), entry]);
    return [...groups.entries()];
  }, [index]);
  const totals = useMemo(() => {
    const prices = index.map((e) => e.medianPrice).filter((p) => p > 0);
    return {
      sales: index.reduce((sum, e) => sum + e.sales, 0),
      low: Math.min(...prices),
      high: Math.max(...prices),
      bands: terciles(prices),
    };
  }, [index]);

  useEffect(() => {
    if (!container.current || index.length === 0) return;
    const wide = window.innerWidth > 900;
    const lons = index.map((e) => e.center[0]);
    const lats = index.map((e) => e.center[1]);
    const bounds: [[number, number], [number, number]] = [
      [Math.min(...lons), Math.min(...lats)],
      [Math.max(...lons), Math.max(...lats)],
    ];
    const map = new maplibregl.Map({
      container: container.current,
      style: baseStyle(),
      bounds,
      // On phones the list covers the bottom 36% of the screen, so keep the dots above it.
      fitBoundsOptions: { padding: wide ? { top: 120, bottom: 50, left: 480, right: 50 } : { top: 180, bottom: Math.round(window.innerHeight * 0.36) + 40, left: 24, right: 24 } },
      pitch: 0,
      bearing: 0,
      maxPitch: 80,
      interactive: false,
      attributionControl: { compact: true },
      fadeDuration: 300,
      canvasContextAttributes: { antialias: true },
    });
    mapRef.current = map;
    const [low, high] = totals.bands;
    let frame = 0;
    map.on("load", () => {
      map.addSource(SOURCE, {
        type: "geojson",
        promoteId: "slug",
        data: {
          type: "FeatureCollection",
          features: index.map((e) => ({
            type: "Feature",
            properties: { slug: e.slug, name: e.name, price: e.medianPrice, sales: e.sales },
            geometry: { type: "Point", coordinates: e.center },
          })),
        },
      });
      map.addLayer({
        id: "dots",
        type: "circle",
        source: SOURCE,
        paint: {
          "circle-radius": ["+", ["interpolate", ["linear"], ["get", "sales"], 100, 4.5, 1000, 9], ["case", ["boolean", ["feature-state", "hover"], false], 3, 0]],
          "circle-radius-transition": { duration: 200, delay: 0 },
          "circle-color": ["step", ["get", "price"], "#7dd3fc", low, "#DCF763", high, "#fb7185"],
          "circle-stroke-color": "#0b1220",
          "circle-stroke-width": 1.5,
        },
      });
      map.addLayer({
        id: "names",
        type: "symbol",
        source: SOURCE,
        layout: {
          "text-field": ["get", "name"],
          "text-font": ["Noto Sans Regular"],
          "text-size": wide ? 12 : 11,
          "text-offset": [0, 1.1],
          "text-anchor": "top",
          "text-optional": true,
          "text-padding": 4,
        },
        paint: { "text-color": "#ffffff", "text-halo-color": "#0b1220", "text-halo-width": 1.4 },
      });
      collapseAttribution(map);
      map.easeTo({ pitch: 48, bearing: -12, duration: 2800, easing: (t) => 1 - Math.pow(1 - t, 3) });
      setReady(true);
      // A slow turn so the county never sits still; stops under reduced-motion.
      if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        const started = performance.now();
        const tick = (now: number) => {
          if (!mapAlive(map)) return;
          if (!map.isEasing()) map.setBearing(-12 + Math.sin((now - started) / 14000) * 6);
          frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
      }
    });
    return () => {
      cancelAnimationFrame(frame);
      mapRef.current = null;
      map.remove();
    };
    // Built once per index load; hover is handled through feature state below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  // Hover from the list lights the marker; hovering a marker lights the list row.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !mapAlive(map)) return;
    for (const entry of index) map.setFeatureState({ source: SOURCE, id: entry.slug }, { hover: entry.slug === hover });
  }, [hover, index, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const canvas = map.getCanvas();
    const onMove = (event: MouseEvent) => {
      if (!mapAlive(map)) return;
      const rect = canvas.getBoundingClientRect();
      const hit = map.queryRenderedFeatures([event.clientX - rect.left, event.clientY - rect.top], { layers: ["dots"] })[0];
      const slug = hit ? String(hit.properties.slug) : null;
      setHover(slug);
      canvas.style.cursor = slug ? "pointer" : "";
    };
    const onClick = (event: MouseEvent) => {
      if (!mapAlive(map)) return;
      const rect = canvas.getBoundingClientRect();
      const hit = map.queryRenderedFeatures([event.clientX - rect.left, event.clientY - rect.top], { layers: ["dots"] })[0];
      if (hit) onPick(String(hit.properties.slug));
    };
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("click", onClick);
    return () => {
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("click", onClick);
    };
  }, [ready, onPick]);

  return (
    <>
      <div ref={container} className="map map-live" aria-label="Map of Los Angeles neighborhoods" />
      <div className="overview show">
        <div className="overview-head">
          <h1>{headline}</h1>
          <p className="hero-body">
            {index.length} neighborhoods, from {money(totals.low)} to {money(totals.high)} at the median. Pick one to fly over it: every sale,
            the trend, what is within reach, the schools, the risks and what is being built.
          </p>
          <div className="legend">
            <span className="legend-item"><span className="swatch swatch-dot" style={{ background: "#7dd3fc" }} />Under {money(totals.bands[0])}</span>
            <span className="legend-item"><span className="swatch swatch-dot" style={{ background: "#DCF763" }} />{money(totals.bands[0])} to {money(totals.bands[1])}</span>
            <span className="legend-item"><span className="swatch swatch-dot" style={{ background: "#fb7185" }} />Over {money(totals.bands[1])}</span>
            <span className="legend-item">Dot size: sales in the last year</span>
          </div>
        </div>
        <div className="overview-list">
          {regions.map(([region, entries]) => (
            <section key={region} className="region">
              <h2>{region}</h2>
              <ul>
                {entries.map((entry) => (
                  <li key={entry.slug}>
                    <button
                      className={`region-row ${hover === entry.slug ? "hot" : ""}`}
                      onMouseEnter={() => setHover(entry.slug)}
                      onMouseLeave={() => setHover(null)}
                      onFocus={() => setHover(entry.slug)}
                      onBlur={() => setHover(null)}
                      onClick={() => onPick(entry.slug)}
                    >
                      <span className="region-name">{entry.name}</span>
                      <span className="region-price">{money(entry.medianPrice)}</span>
                      <span className="region-sales">{entry.sales.toLocaleString()} sales</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <p className="overview-foot">
            Built from MLS closed sales (last 12 months), FEMA, CAL FIRE, the California Geological Survey, EPA, OpenStreetMap, the Census, U.S. DOT, FHFA and Freddie Mac.
          </p>
        </div>
      </div>
    </>
  );
}
