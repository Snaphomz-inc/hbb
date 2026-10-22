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
};

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
  add(
    "sales",
    points(data.sales.map(([lon, lat, price, sqft, kind, beds, monthsAgo]) => ({ lon, lat, price, sqft, kind, beds, monthsAgo }))),
    {
      type: "circle",
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 2.2, 14, 3.6, 16, 7],
        "circle-color": ["step", ["get", "price"], "#7dd3fc", low, "#DCF763", high, "#fb7185"],
        "circle-stroke-color": "#0b1220",
        "circle-stroke-width": 0.8,
        "circle-pitch-alignment": "map",
      },
    } as never,
  );

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
