/**
 * Lot lines on Google's mesh: the LA County Assessor's parcel polygons (the 2025 roll, from the
 * County's public ArcGIS feature service), drawn as thin white outlines a metre and a half above
 * the mesh so they drape over roofs and gardens. They only appear once the camera is close enough
 * for a lot to be more than a few pixels (RANGE_MAX); further out they would be noise and
 * thousands of elements. Whenever the camera comes to rest the parcels within reach of its centre
 * are fetched (one request, up to the service's 2000 per call) and the ones already on the map are
 * kept, so panning along a street fills in as you go. The parcel under a hovered home is lit in
 * the home's colour.
 */

type Map3D = HTMLElement & { center: { lat: number; lng: number; altitude: number } | null; range: number; tilt: number; heading: number };
type Polyline = HTMLElement & { strokeColor: string; strokeWidth: number };
/** [lon, lat] vertices; the first ring of a polygon is its outline, the rest are holes. */
type Ring = number[][];
type Parcel = { ain: string; polygons: Ring[][]; lines: Polyline[]; lon: number; lat: number };

export type ParcelLayer = {
  /** Light the parcel under a point in a colour, or none. */
  highlight(at: { lon: number; lat: number } | null, colour?: string): void;
  destroy(): void;
};

const SERVICE = "https://services.arcgis.com/RmCCgQtiZLDCtblq/arcgis/rest/services/ASSR_PARCELS_25_View/FeatureServer/0/query";
export const PARCEL_CREDIT = "Lot lines · LA County Assessor";
/** Camera distance (metres) beyond which no lot lines are drawn. */
export const PARCEL_RANGE_MAX = 1600;
/** How far around the camera's centre parcels are fetched, metres: about what the view covers. */
const REACH_MIN = 250;
const REACH_MAX = 900;
/** Parcels kept on the map at once; past KEEP the farthest from the camera go until TRIM_TO remain. */
const KEEP = 1400;
const TRIM_TO = 1000;
const LIFT = 1.5;
/** New parcels drawn per animation frame. */
const ADD_PER_FRAME = 60;
const LINE = { colour: "#ffffffb8", width: 2 };
const LIT_WIDTH = 3.5;

function metres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dx = (b.lng - a.lng) * 111320 * Math.cos((a.lat * Math.PI) / 180);
  const dy = (b.lat - a.lat) * 110540;
  return Math.hypot(dx, dy);
}

function inRing(ring: Ring, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function contains(parcel: Parcel, lon: number, lat: number): boolean {
  return parcel.polygons.some((rings) => inRing(rings[0], lon, lat) && !rings.slice(1).some((hole) => inRing(hole, lon, lat)));
}

import { watchStill } from "./still";

type Feature = { properties?: { AIN?: string }; geometry?: { type: string; coordinates: unknown } };

export function parcelLines(map3d: Map3D, lib: Record<string, unknown>, alive: () => boolean, onCount: (count: number) => void): ParcelLayer {
  const Polyline3D = lib.Polyline3DElement as new (options: Record<string, unknown>) => Polyline;
  const AltitudeMode = lib.AltitudeMode as Record<string, string>;
  const have = new Map<string, Parcel>();
  let fetched: { lat: number; lng: number; reach: number } | null = null;
  let controller: AbortController | null = null;
  let lit: Parcel | null = null;

  const unlight = () => {
    if (!lit) return;
    for (const line of lit.lines) {
      line.strokeColor = LINE.colour;
      line.strokeWidth = LINE.width;
    }
    lit = null;
  };
  const drop = (parcel: Parcel) => {
    if (lit === parcel) lit = null;
    for (const line of parcel.lines) line.remove();
    have.delete(parcel.ain);
  };
  const clear = () => {
    controller?.abort();
    controller = null;
    for (const parcel of [...have.values()]) drop(parcel);
    fetched = null;
    onCount(0);
  };
  const trim = (centre: { lat: number; lng: number }) => {
    if (have.size <= KEEP) return;
    const far = [...have.values()].sort((a, b) => metres(centre, { lat: b.lat, lng: b.lon }) - metres(centre, { lat: a.lat, lng: a.lon }));
    for (const parcel of far.slice(0, have.size - TRIM_TO)) drop(parcel);
  };
  const add = (feature: Feature) => {
    const ain = feature.properties?.AIN;
    const geometry = feature.geometry;
    if (!ain || !geometry || have.has(ain)) return;
    const polygons = (geometry.type === "Polygon" ? [geometry.coordinates] : geometry.type === "MultiPolygon" ? geometry.coordinates : []) as Ring[][];
    if (polygons.length === 0 || polygons[0].length === 0 || polygons[0][0].length === 0) return;
    const [lon, lat] = polygons[0][0][0];
    const lines: Polyline[] = [];
    for (const rings of polygons) {
      for (const ring of rings) {
        const line = new Polyline3D({
          path: ring.map(([x, y]) => ({ lat: y, lng: x, altitude: LIFT })),
          strokeColor: LINE.colour,
          strokeWidth: LINE.width,
          outerColor: "#00000070",
          outerWidth: 0.3,
          altitudeMode: AltitudeMode.RELATIVE_TO_MESH,
          drawsOccludedSegments: false,
        });
        map3d.append(line);
        lines.push(line);
      }
    }
    have.set(ain, { ain, polygons, lines, lon, lat });
  };
  const load = async (centre: { lat: number; lng: number }, reach: number) => {
    controller?.abort();
    controller = new AbortController();
    const { signal } = controller;
    const dLat = reach / 110540;
    const dLon = reach / (111320 * Math.cos((centre.lat * Math.PI) / 180));
    const params = new URLSearchParams({
      f: "geojson",
      geometry: [centre.lng - dLon, centre.lat - dLat, centre.lng + dLon, centre.lat + dLat].map((v) => v.toFixed(6)).join(","),
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields: "AIN",
      outSR: "4326",
      geometryPrecision: "6",
      returnGeometry: "true",
    });
    let features: Feature[];
    try {
      const response = await fetch(`${SERVICE}?${params}`, { signal });
      if (!response.ok) return;
      features = ((await response.json()) as { features?: Feature[] }).features ?? [];
    } catch {
      return; // aborted by a newer request, or the service is unreachable: the lines are a bonus
    }
    if (!alive() || signal.aborted) return;
    // A few hundred new lines at once would stall the frame; they go on over a few frames.
    const queue = features.filter((feature) => feature.properties?.AIN && !have.has(feature.properties.AIN));
    const step = () => {
      if (!alive() || signal.aborted) return;
      for (const feature of queue.splice(0, ADD_PER_FRAME)) add(feature);
      if (queue.length > 0) {
        requestAnimationFrame(step);
        return;
      }
      trim(centre);
      onCount(have.size);
    };
    step();
  };
  const refresh = () => {
    const centre = map3d.center;
    if (!alive() || !centre) return;
    if (map3d.range > PARCEL_RANGE_MAX) {
      if (have.size > 0 || controller) clear();
      return;
    }
    const reach = Math.min(REACH_MAX, Math.max(REACH_MIN, map3d.range * 1.1));
    // Still inside the last fetch, at a similar scale: nothing new to ask for.
    if (fetched && metres(fetched, centre) < fetched.reach * 0.45 && reach <= fetched.reach * 1.3) return;
    fetched = { lat: centre.lat, lng: centre.lng, reach };
    void load(centre, reach);
  };
  const onSteady = (event: Event) => {
    if ((event as Event & { isSteady?: boolean }).isSteady) refresh();
  };
  map3d.addEventListener("gmp-steadychange", onSteady);
  const stopWatching = watchStill(map3d, alive, refresh);
  refresh();

  return {
    highlight(at, colour = "#dcf763") {
      const next = at ? ([...have.values()].find((parcel) => contains(parcel, at.lon, at.lat)) ?? null) : null;
      if (next === lit) return;
      unlight();
      if (!next) return;
      lit = next;
      for (const line of next.lines) {
        line.strokeColor = colour;
        line.strokeWidth = LIT_WIDTH;
      }
    },
    destroy() {
      stopWatching();
      map3d.removeEventListener("gmp-steadychange", onSteady);
      clear();
    },
  };
}
