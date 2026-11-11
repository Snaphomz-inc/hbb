import { useEffect, useRef, useState } from "react";
import { money } from "../lib/format";
import { listingUrl } from "../links";

/**
 * The look-around view: Google's photorealistic 3D mesh, opened on exactly the camera the
 * story is showing, free to scroll-zoom and drag, and handed back to the story on exit.
 * Needs VITE_GOOGLE_MAPS_KEY (Maps JavaScript API). Without it nothing here is reachable.
 */

export type ViewCamera = {
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
  /** Ground height at the centre, metres, so Google orbits the same point. */
  altitude: number;
  /** The map's own centre height, metres (terrain units): 0 for the story, the ground under a focused sale. */
  elevation?: number;
};

type GoogleCamera = { center: { lat: number; lng: number; altitude: number }; range: number; tilt: number; heading: number };

declare global {
  interface Window {
    google?: { maps: { importLibrary: (name: string) => Promise<Record<string, unknown>> } };
    __gmapsReady?: () => void;
  }
}

const KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY;
export const exploreAvailable = Boolean(KEY);

/**
 * Google's range (camera to centre, metres) that shows the same ground as MapLibre's view.
 * MapLibre's camera sits 1.5 viewport heights from the centre (36.87° vertical field of view);
 * Google's field of view is wider. 0.8 viewport heights matched the frame when the two were
 * toggled over each other at the dive's landing camera (tilt 60-64) over Glendale and over the
 * county-wide commute view: freeways, parks and ridge lines in the same screen positions.
 */
const CAMERA_HEIGHTS = 0.8;
const EQUATOR_METERS_PER_PIXEL = 156543.03392;

function metersPerPixel(lat: number, zoom: number): number {
  return (EQUATOR_METERS_PER_PIXEL * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

export function toGoogle(camera: ViewCamera, heightPx: number): GoogleCamera {
  return {
    center: { lat: camera.center[1], lng: camera.center[0], altitude: camera.altitude },
    range: CAMERA_HEIGHTS * heightPx * metersPerPixel(camera.center[1], camera.zoom),
    tilt: camera.pitch,
    heading: camera.bearing,
  };
}

export function fromGoogle(google: GoogleCamera, heightPx: number): ViewCamera {
  const mpp = google.range / (CAMERA_HEIGHTS * heightPx);
  const zoom = Math.log2((EQUATOR_METERS_PER_PIXEL * Math.cos((google.center.lat * Math.PI) / 180)) / mpp);
  return { center: [google.center.lng, google.center.lat], zoom, pitch: google.tilt, bearing: google.heading, altitude: google.center.altitude };
}

let loading: Promise<Record<string, unknown>> | null = null;

function loadMaps3d(): Promise<Record<string, unknown>> {
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const params = new URLSearchParams({ key: KEY ?? "", v: "weekly", libraries: "maps3d", loading: "async", callback: "__gmapsReady" });
      window.__gmapsReady = () => {
        if (!window.google) return reject(new Error("Google Maps did not initialise"));
        resolve(window.google.maps.importLibrary("maps3d"));
      };
      const script = document.createElement("script");
      script.src = `https://maps.googleapis.com/maps/api/js?${params}`;
      script.async = true;
      script.onerror = () => reject(new Error("Google Maps failed to load"));
      document.head.append(script);
    });
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

/** Fetch the Google script while the story plays, so entering look-around only waits for tiles. */
export function preloadMaps3d(): void {
  if (KEY) loadMaps3d().catch(() => undefined);
}

type Map3D = HTMLElement & GoogleCamera;

/** A sold home to pin on the mesh; the ones with a listing open it on click. */
export type Sale3D = { id: number; lon: number; lat: number; price: number; listing: string; address: string };

type Marker3D = HTMLElement & { position: { lat: number; lng: number; altitude: number } };

/** How many pins ride on the mesh at once: the nearest to wherever the camera is looking. */
const PIN_LIMIT = 160;

function metresBetween(a: { lat: number; lng: number }, b: { lat: number; lon: number }): number {
  const dx = (b.lon - a.lng) * 111320 * Math.cos((a.lat * Math.PI) / 180);
  const dy = (b.lat - a.lat) * 110540;
  return Math.hypot(dx, dy);
}

/**
 * The sold homes as pins on Google's mesh, each labelled with its price; a pin with a listing opens
 * it. Only the nearest PIN_LIMIT to the camera's centre are on the map, and the set is refreshed
 * every time the camera comes to rest somewhere else.
 */
async function pinSales(map3d: Map3D, lib: Record<string, unknown>, sales: Sale3D[], alive: () => boolean): Promise<void> {
  if (sales.length === 0 || !window.google) return;
  const Marker = lib.Marker3DInteractiveElement as new (options: Record<string, unknown>) => Marker3D;
  const AltitudeMode = lib.AltitudeMode as Record<string, string>;
  const markerLib = await window.google.maps.importLibrary("marker");
  const PinElement = markerLib.PinElement as new (options: Record<string, unknown>) => HTMLElement;
  if (!alive()) return;
  const shown = new Map<number, Marker3D>();
  let lastCentre: { lat: number; lng: number } | null = null;
  const refresh = () => {
    const centre = map3d.center;
    if (!alive() || !centre) return;
    if (lastCentre && metresBetween(lastCentre, { lat: centre.lat, lon: centre.lng }) < 150 && shown.size > 0) return;
    lastCentre = { lat: centre.lat, lng: centre.lng };
    const nearest = sales
      .map((sale) => ({ sale, d: metresBetween(centre, sale) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, PIN_LIMIT);
    const keep = new Set(nearest.map((n) => n.sale.id));
    for (const [id, marker] of shown) {
      if (!keep.has(id)) {
        marker.remove();
        shown.delete(id);
      }
    }
    for (const { sale } of nearest) {
      if (shown.has(sale.id)) continue;
      const marker = new Marker({
        position: { lat: sale.lat, lng: sale.lon, altitude: 0 },
        altitudeMode: AltitudeMode.RELATIVE_TO_MESH ?? AltitudeMode.CLAMP_TO_GROUND,
        label: money(sale.price),
        extruded: false,
      });
      marker.append(new PinElement({ background: sale.listing ? "#dcf763" : "#94a3b8", borderColor: "#111827", glyphColor: "#111827", scale: 0.85 }));
      if (sale.listing) marker.addEventListener("gmp-click", () => window.open(listingUrl(sale.listing), "_blank", "noopener"));
      map3d.append(marker);
      shown.set(sale.id, marker);
    }
  };
  refresh();
  map3d.addEventListener("gmp-steadychange", (event) => {
    if ((event as Event & { isSteady?: boolean }).isSteady) refresh();
  });
}

/**
 * `getCamera` is read twice: when Google is created, and again the moment its mesh is ready, so the
 * story view can keep drifting underneath while tiles load and the crossfade still lines up.
 */
export function Explore({
  getCamera,
  closing,
  minWait = 0,
  onExit,
  sales = [],
}: {
  getCamera: () => ViewCamera;
  closing: boolean;
  minWait?: number;
  onExit: (camera: ViewCamera) => void;
  sales?: Sale3D[];
}) {
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map3D | null>(null);
  const opened = useRef<ViewCamera>(getCamera());
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    let alive = true;
    const mountedAt = performance.now();
    const height = window.innerHeight;
    loadMaps3d()
      .then((lib) => {
        if (!alive || !host.current) return;
        const Map3DElement = lib.Map3DElement as new (options: Record<string, unknown>) => Map3D;
        const MapMode = lib.MapMode as Record<string, string>;
        const map3d = new Map3DElement({ ...toGoogle(opened.current, height), mode: MapMode.HYBRID, defaultUIDisabled: true, gestureHandling: "GREEDY" });
        mapRef.current = map3d;
        host.current.append(map3d);
        pinSales(map3d, lib, sales, () => alive).catch(() => undefined);
        let shown = false;
        const show = () => {
          if (shown || !alive) return;
          shown = true;
          // Let the story's own move (the dive) finish, catch up with where the camera ended, give the
          // mesh a beat to settle on it, then crossfade.
          const wait = Math.max(0, mountedAt + minWait - performance.now());
          setTimeout(() => {
            if (!alive) return;
            const now = toGoogle(getCamera(), height);
            map3d.center = now.center;
            map3d.range = now.range;
            map3d.tilt = now.tilt;
            map3d.heading = now.heading;
            setTimeout(() => alive && setState("ready"), 350);
          }, wait);
        };
        map3d.addEventListener("gmp-steadychange", (event) => {
          if ((event as Event & { isSteady?: boolean }).isSteady) show();
        });
        // A slow network still gets the view after a few seconds.
        setTimeout(show, 4500);
      })
      .catch(() => {
        if (alive) setState("failed");
      });
    document.documentElement.classList.add("exploring");
    return () => {
      alive = false;
      document.documentElement.classList.remove("exploring");
    };
    // Opened once per entry; the camera is the one it opened on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const exit = () => {
    const map3d = mapRef.current;
    if (map3d && map3d.center && state === "ready") {
      onExit(fromGoogle({ center: map3d.center, range: map3d.range, tilt: map3d.tilt, heading: map3d.heading }, window.innerHeight));
    } else {
      onExit(opened.current);
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") exit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className={`explore ${state === "ready" ? "show" : ""} ${closing ? "closing" : ""}`}>
      <div className="explore-veil" />
      <div ref={host} className="explore-map" />
      <div className="explore-loading" aria-live="polite">
        <div className="explore-loading-label">{state === "failed" ? "Google 3D could not load here" : "Opening Google 3D"}</div>
        {state === "loading" && <div className="explore-loading-bar" />}
      </div>
      <button className="explore-exit" onClick={exit}>
        Back to the story
      </button>
      <div className="explore-hint">
        {sales.length > 0 ? (
          <>
            <span className="explore-hint-pin" aria-hidden="true" /> sold in the last year, click for the listing · scroll to zoom · drag to look around · esc to return
          </>
        ) : (
          "scroll to zoom · drag to look around · esc to return"
        )}
      </div>
    </div>
  );
}
