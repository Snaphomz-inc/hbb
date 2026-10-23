import maplibregl from "maplibre-gl";
import type { FeatureCollection as GeoJsonFeatureCollection } from "geojson";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef } from "react";
import type { FeatureCollection, Neighborhood } from "../types";
import { baseStyle } from "./style";

type OpacityTarget = Record<string, unknown>;

/**
 * Data layers, with the opacity each one shows at (a number or a data-driven
 * expression). Everything starts hidden; showLayers() fades them in and out.
 */
const TARGETS: Record<string, OpacityTarget> = {
  sales: { "circle-opacity": 0.92, "circle-stroke-opacity": 0.9 },
  "sales-heat": { "heatmap-opacity": 0.78 },
  "routes-casing": { "line-opacity": 0.8 },
  routes: { "line-opacity": 1 },
  "route-ends": { "circle-opacity": 1, "circle-stroke-opacity": 1 },
  parks: { "fill-opacity": 0.38 },
  walk: { "fill-opacity": ["interpolate", ["linear"], ["coalesce", ["get", "walk"], 0], 6, 0.0, 12, 0.05, 20, 0.16] },
  "pois-cafe": { "circle-opacity": 0.75, "circle-stroke-opacity": 0 },
  "pois-grocery": { "circle-opacity": 1, "circle-stroke-opacity": 1 },
  "pois-rail": { "circle-opacity": 1, "circle-stroke-opacity": 1 },
  "pois-park": { "circle-opacity": 0.9, "circle-stroke-opacity": 0.9 },
  zones: { "line-opacity": 0.7 },
  schools: { "circle-opacity": 1, "circle-stroke-opacity": 1 },
  flood: { "fill-opacity": ["match", ["get", "cls"], "sfha", 0.42, 0.28] },
  "flood-line": { "line-opacity": 0.9 },
  fire: { "fill-opacity": ["match", ["get", "severity"], 1, 0.2, 2, 0.28, 3, 0.36, 0.28] },
  liquefaction: { "fill-opacity": 0.3 },
  landslide: { "fill-opacity": 0.38 },
  fault: { "fill-opacity": 0.55 },
  noise: { "fill-opacity": 0.38 },
  permits: { "circle-opacity": 0.95, "circle-stroke-opacity": 0.9 },
};

export const LAYER_GROUPS: Record<string, string[]> = {
  flood: ["flood", "flood-line"],
  routes: ["routes-casing", "routes", "route-ends"],
};

/** How long a sale's pulse ring lasts, in months of story time. */
const PULSE = 1.4;

/** When each sale appears on the timeline: its 30-day bucket plus a stable jitter so a month trickles in. */
export function saleTime(i: number, monthsAgo: number): number {
  return 11 - monthsAgo + (((i * 2654435761) >>> 0) % 1000) / 1000;
}

type SalesClock = { t: Float64Array; on: Uint8Array; pulsing: Set<number> };
const clocks = new WeakMap<maplibregl.Map, SalesClock>();

/**
 * Advance the sales timeline. `clock` is in months from the start of the year (0 to 12 and a bit);
 * null shows every sale with no pulses. Feature state keeps this off the worker thread.
 */
export function setSalesClock(map: maplibregl.Map, clock: number | null): void {
  const state = clocks.get(map);
  if (!state || !mapAlive(map)) return;
  const { t, on, pulsing } = state;
  for (let i = 0; i < t.length; i += 1) {
    const age = clock == null ? 99 : clock - t[i];
    const show = age >= 0;
    if (show !== Boolean(on[i])) {
      on[i] = show ? 1 : 0;
      map.setFeatureState({ source: "sales", id: i }, { on: show });
    }
    if (age >= 0 && age <= PULSE) {
      pulsing.add(i);
      map.setFeatureState({ source: "sales", id: i }, { age });
    } else if (pulsing.has(i)) {
      pulsing.delete(i);
      map.setFeatureState({ source: "sales", id: i }, { age: 9 });
    }
  }
}

const BUILDING_HEIGHT = ["coalesce", ["get", "render_height"], 6];

/**
 * Make the buildings grow with the camera. Heights cannot be animated per frame without re-tiling,
 * but a zoom-keyed height is interpolated in the shader, so the height is written once as a line
 * through zero at `zoom0` and full height at `zoom0 + push`, and the camera's push-in does the rest.
 * Negative values below zoom0 clamp to zero in the shader. Knots sit on integer zooms because that
 * is where the interpolation happens; three of them keep the line straight across a tile reload.
 */
export function raiseBuildings(map: maplibregl.Map, zoom0: number, push: number): void {
  if (!mapAlive(map) || !map.getLayer("buildings")) return;
  const tz = Math.floor(zoom0);
  const at = (zoom: number) => ["*", BUILDING_HEIGHT, (zoom - zoom0) / push];
  map.setPaintProperty("buildings", "fill-extrusion-height", ["interpolate", ["linear"], ["zoom"], tz, at(tz), tz + 1, at(tz + 1), tz + 2, at(tz + 2)]);
  // The re-tiled buckets take a moment to arrive; fade in after they have, so the old full-height ones never flash.
  window.setTimeout(() => {
    if (mapAlive(map) && map.getLayer("buildings")) map.setPaintProperty("buildings", "fill-extrusion-opacity", 0.85);
  }, 350);
}

export function lowerBuildings(map: maplibregl.Map): void {
  if (!mapAlive(map) || !map.getLayer("buildings")) return;
  map.setPaintProperty("buildings", "fill-extrusion-opacity", 0);
  map.setPaintProperty("buildings", "fill-extrusion-height", BUILDING_HEIGHT);
}

/** Draw the commute routes from their start to `progress` (0 to 1) of their length. */
export function setRouteProgress(map: maplibregl.Map, progress: number): void {
  if (!mapAlive(map) || !map.getLayer("routes")) return;
  const head = Math.max(0, Math.min(1, progress));
  map.setPaintProperty("routes", "line-gradient", [
    "interpolate", ["linear"], ["line-progress"],
    head - 0.06, "#DCF763",
    head, "rgba(220, 247, 99, 0)",
  ]);
}

const TRANSITION = { duration: 750, delay: 0 };

function withTransitions(paint: Record<string, unknown>, target: OpacityTarget): Record<string, unknown> {
  const out: Record<string, unknown> = { ...paint };
  for (const property of Object.keys(target)) {
    out[property] = 0;
    out[`${property}-transition`] = TRANSITION;
  }
  return out;
}

function points(items: Array<{ lon: number; lat: number; [key: string]: unknown }>): GeoJsonFeatureCollection {
  return {
    type: "FeatureCollection",
    features: items.map((item) => ({
      type: "Feature",
      properties: { ...item },
      geometry: { type: "Point", coordinates: [item.lon, item.lat] },
    })),
  };
}

function quantiles(values: number[]): [number, number] {
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (share: number) => sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] ?? 0;
  return [pick(1 / 3), pick(2 / 3)];
}

function noiseSquares(data: Neighborhood): GeoJsonFeatureCollection {
  const noise = data.noise;
  if (!noise) return { type: "FeatureCollection", features: [] };
  const half = noise.cell / 2;
  return {
    type: "FeatureCollection",
    features: noise.cells.map(([lon, lat, db]) => ({
      type: "Feature",
      properties: { db },
      geometry: {
        type: "Polygon",
        coordinates: [[[lon - half, lat - half], [lon + half, lat - half], [lon + half, lat + half], [lon - half, lat + half], [lon - half, lat - half]]],
      },
    })),
  };
}

function empty(): GeoJsonFeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

function addDataLayers(map: maplibregl.Map, data: Neighborhood): void {
  const add = (id: string, source: FeatureCollection | GeoJsonFeatureCollection | null | undefined, layer: Omit<maplibregl.LayerSpecification, "id" | "source"> & { paint?: Record<string, unknown> }, before?: string) => {
    map.addSource(id, { type: "geojson", data: (source ?? empty()) as GeoJsonFeatureCollection });
    const target = TARGETS[id] ?? {};
    map.addLayer({ ...(layer as maplibregl.LayerSpecification), id, source: id, paint: withTransitions(layer.paint ?? {}, target) } as maplibregl.LayerSpecification, before);
  };

  // Area fills go under the buildings so the city still reads as a city.
  add("walk", data.walkability?.polygons, {
    type: "fill",
    paint: { "fill-color": "#DCF763" },
  } as never, "buildings");
  add("parks", data.pois?.parks, { type: "fill", paint: { "fill-color": "#34d399" } }, "buildings");
  add("flood", data.hazards.flood, {
    type: "fill",
    paint: { "fill-color": ["match", ["get", "cls"], "sfha", "#3b82f6", "#93c5fd"] },
  } as never, "buildings");
  map.addLayer(
    { id: "flood-line", type: "line", source: "flood", paint: withTransitions({ "line-color": "#bfdbfe", "line-width": 1.2 }, TARGETS["flood-line"]) } as maplibregl.LayerSpecification,
    "buildings",
  );
  add("fire", data.hazards.fire, {
    type: "fill",
    paint: { "fill-color": ["match", ["get", "severity"], 1, "#fbbf24", 2, "#f97316", 3, "#dc2626", "#f97316"] },
  } as never, "buildings");
  add("liquefaction", data.hazards.liquefaction, { type: "fill", paint: { "fill-color": "#a855f7" } }, "buildings");
  add("landslide", data.hazards.landslide, { type: "fill", paint: { "fill-color": "#b45309" } }, "buildings");
  add("fault", data.hazards.fault, { type: "fill", paint: { "fill-color": "#ef4444" } }, "buildings");
  add("noise", noiseSquares(data), {
    type: "fill",
    paint: { "fill-color": ["interpolate", ["linear"], ["get", "db"], 55, "#fde047", 65, "#f97316", 75, "#dc2626"] },
  } as never, "buildings");
  add("zones", data.zones, { type: "line", paint: { "line-color": "#ffffff", "line-width": 1.5, "line-dasharray": [2, 2] } });

  const prices = data.sales.map((s) => s[2]);
  const [low, high] = quantiles(prices);
  const priceColor = ["step", ["get", "price"], "#7dd3fc", low, "#DCF763", high, "#fb7185"];
  // Zoom must be the outer expression, so the on/off switch sits inside each stop.
  const shown = ["boolean", ["feature-state", "on"], false];
  const dotRadius = ["interpolate", ["linear"], ["zoom"], 12, ["case", shown, 2.2, 0], 14, ["case", shown, 3.6, 0], 16, ["case", shown, 7, 0]];
  const salesSource: GeoJsonFeatureCollection = {
    type: "FeatureCollection",
    features: data.sales.map(([lon, lat, price, sqft, kind, beds, monthsAgo], i) => ({
      type: "Feature",
      id: i,
      properties: { price, sqft, kind, beds, monthsAgo },
      geometry: { type: "Point", coordinates: [lon, lat] },
    })),
  };
  clocks.set(map, { t: Float64Array.from(data.sales, (s, i) => saleTime(i, s[6])), on: new Uint8Array(data.sales.length), pulsing: new Set() });
  // Where the money went: every sale as heat, weighted by price, under the buildings like a glow on the ground.
  map.addSource("sales", { type: "geojson", data: salesSource });
  map.addLayer(
    {
      id: "sales-heat",
      type: "heatmap",
      source: "sales",
      paint: withTransitions(
        {
          "heatmap-weight": ["min", 3, ["/", ["get", "price"], 1200000]],
          "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 11, 12, 13, 26, 15, 48],
          "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 11, 0.5, 15, 1.1],
          "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"], 0, "rgba(29, 78, 216, 0)", 0.15, "rgba(29, 78, 216, 0.5)", 0.4, "rgba(125, 211, 252, 0.85)", 0.7, "#DCF763", 1, "#fb7185"],
        },
        TARGETS["sales-heat"],
      ),
    } as maplibregl.LayerSpecification,
    "buildings",
  );
  map.addLayer({
    id: "sales",
    type: "circle",
    source: "sales",
    paint: withTransitions(
      {
        // Hidden until the timeline reaches the sale; see setSalesClock.
        "circle-radius": dotRadius,
        "circle-color": priceColor,
        "circle-stroke-color": "#0b1220",
        "circle-stroke-width": 0.8,
        "circle-pitch-alignment": "map",
      },
      TARGETS.sales,
    ),
  } as maplibregl.LayerSpecification);
  // The pulse: a ring that grows and fades for a moment after each sale lands.
  map.addLayer({
    id: "sales-pulse",
    type: "circle",
    source: "sales",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["coalesce", ["feature-state", "age"], 9], 0, 3, PULSE, 30, PULSE + 0.01, 0],
      "circle-color": "rgba(0, 0, 0, 0)",
      "circle-stroke-color": priceColor,
      "circle-stroke-width": 1.5,
      "circle-stroke-opacity": ["interpolate", ["linear"], ["coalesce", ["feature-state", "age"], 9], 0, 0.95, PULSE, 0],
      "circle-pitch-alignment": "map",
    },
  } as unknown as maplibregl.LayerSpecification);

  // Commutes drawn along real streets; line-gradient needs lineMetrics and is animated by setRouteProgress.
  const routes = data.routes ?? [];
  map.addSource("routes", {
    type: "geojson",
    lineMetrics: true,
    data: { type: "FeatureCollection", features: routes.map((r) => ({ type: "Feature", properties: { to: r.to, kind: r.kind }, geometry: { type: "LineString", coordinates: r.line } })) },
  });
  map.addLayer({
    id: "routes-casing",
    type: "line",
    source: "routes",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: withTransitions({ "line-color": "#0b1220", "line-width": ["interpolate", ["linear"], ["zoom"], 9, 5, 14, 10] }, TARGETS["routes-casing"]),
  } as maplibregl.LayerSpecification);
  map.addLayer({
    id: "routes",
    type: "line",
    source: "routes",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: withTransitions({ "line-width": ["interpolate", ["linear"], ["zoom"], 9, 2.5, 14, 5] }, TARGETS.routes),
  } as maplibregl.LayerSpecification);
  setRouteProgress(map, 1);
  add("route-ends", points([{ lon: data.center[0], lat: data.center[1], kind: "home" }, ...routes.map((r) => ({ lon: r.lon, lat: r.lat, kind: r.kind }))]), {
    type: "circle",
    paint: {
      "circle-radius": ["match", ["get", "kind"], "home", 7, 6],
      "circle-color": ["match", ["get", "kind"], "home", "#DCF763", "#ffffff"],
      "circle-stroke-color": ["match", ["get", "kind"], "home", "#0b1220", "#DCF763"],
      "circle-stroke-width": 2,
    },
  } as never);

  const pois = data.pois?.categories ?? {};
  add("pois-cafe", points([...(pois.cafe ?? []), ...(pois.restaurant ?? [])]), {
    type: "circle",
    paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 1.5, 16, 3.5], "circle-color": "#ffffff", "circle-pitch-alignment": "map" },
  } as never);
  add("pois-park", points([...(pois.playground ?? []), ...(pois.dogpark ?? [])]), {
    type: "circle",
    paint: { "circle-radius": 3.5, "circle-color": "#34d399", "circle-stroke-color": "#052e16", "circle-stroke-width": 1 },
  } as never);
  add("pois-grocery", points(pois.grocery ?? []), {
    type: "circle",
    paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 4, 16, 7], "circle-color": "#DCF763", "circle-stroke-color": "#111827", "circle-stroke-width": 1.5 },
  } as never);
  add("pois-rail", points(pois.rail ?? []), {
    type: "circle",
    paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 5, 16, 9], "circle-color": "#60a5fa", "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 },
  } as never);

  add("schools", points(data.schools.filter((s) => s.public).map((s) => ({ ...s }))), {
    type: "circle",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["coalesce", ["get", "enrollment"], 300], 100, 4, 600, 7, 2500, 12],
      "circle-color": ["match", ["get", "type"], "Elementary", "#DCF763", "Middle", "#fbbf24", "High", "#fb7185", "#ffffff"],
      "circle-stroke-color": "#111827",
      "circle-stroke-width": 1.5,
    },
  } as never);

  add("permits", points((data.permits?.points ?? []).map(([lon, lat, group]) => ({ lon, lat, group }))), {
    type: "circle",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 2, 15, 4.5],
      "circle-color": ["match", ["get", "group"], "New homes", "#DCF763", "Additions", "#ffffff", "Pools and spas", "#60a5fa", "Solar", "#fbbf24", "Demolitions", "#fb7185", "#9ca3af"],
      "circle-stroke-color": "#0b1220",
      "circle-stroke-width": 0.8,
      "circle-pitch-alignment": "map",
    },
  } as never);
}

/** Collapse the attribution badge; MapLibre opens it on load and the map is not interactive. */
export function collapseAttribution(map: maplibregl.Map): void {
  map.getContainer().querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
}

/** True until map.remove() has run; calls on a removed map throw. */
export function mapAlive(map: maplibregl.Map): boolean {
  const inner = map as unknown as { _removed?: boolean; style?: unknown };
  return !inner._removed && inner.style !== undefined;
}

/** Fade data layers in or out. `visible` holds story layer ids; groups expand to their map layers. */
export function showLayers(map: maplibregl.Map, visible: Iterable<string>): void {
  if (!mapAlive(map)) return;
  const wanted = new Set<string>();
  for (const id of visible) for (const layer of LAYER_GROUPS[id] ?? [id]) wanted.add(layer);
  for (const [id, target] of Object.entries(TARGETS)) {
    if (!map.getLayer(id)) continue;
    const on = wanted.has(id);
    for (const [property, value] of Object.entries(target)) {
      map.setPaintProperty(id, property, on ? (value as never) : 0);
    }
  }
}

export function MapScene({ data, onReady }: { data: Neighborhood; onReady: (map: maplibregl.Map | null) => void }) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!container.current) return;
    const map = new maplibregl.Map({
      container: container.current,
      style: baseStyle(),
      center: data.center,
      zoom: 13,
      pitch: 55,
      bearing: data.camera.bearing ?? 30,
      maxPitch: 80,
      interactive: false,
      attributionControl: { compact: true },
      fadeDuration: 300,
      canvasContextAttributes: { antialias: true },
    });
    let alive = true;
    map.on("load", () => {
      if (!alive) return;
      addDataLayers(map, data);
      collapseAttribution(map);
      onReady(map);
    });
    return () => {
      alive = false;
      onReady(null);
      map.remove();
    };
    // The scene is remounted per neighborhood (keyed by slug), so data is stable here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={container} className="map" aria-hidden="true" />;
}
