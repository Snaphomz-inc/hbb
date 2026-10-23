import { useEffect, useRef, useState } from "react";

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
 * Google's field of view is wider, and 1.0 viewport heights matched the frame when checked
 * side by side over Glendale (freeways and ridge lines in the same screen positions).
 */
const CAMERA_HEIGHTS = 1.0;
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

/**
 * `getCamera` is read twice: when Google is created, and again the moment its mesh is ready, so the
 * story view can keep drifting underneath while tiles load and the crossfade still lines up.
 */
export function Explore({ getCamera, closing, onExit }: { getCamera: () => ViewCamera; closing: boolean; onExit: (camera: ViewCamera) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map3D | null>(null);
  const opened = useRef<ViewCamera>(getCamera());
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    let alive = true;
    const height = window.innerHeight;
    loadMaps3d()
      .then((lib) => {
        if (!alive || !host.current) return;
        const Map3DElement = lib.Map3DElement as new (options: Record<string, unknown>) => Map3D;
        const MapMode = lib.MapMode as Record<string, string>;
        const map3d = new Map3DElement({ ...toGoogle(opened.current, height), mode: MapMode.HYBRID, defaultUIDisabled: true, gestureHandling: "GREEDY" });
        mapRef.current = map3d;
        host.current.append(map3d);
        let shown = false;
        const show = () => {
          if (shown || !alive) return;
          shown = true;
          // Catch up with the story's drift, give the mesh a beat to settle on it, then crossfade.
          const now = toGoogle(getCamera(), height);
          map3d.center = now.center;
          map3d.range = now.range;
          map3d.tilt = now.tilt;
          map3d.heading = now.heading;
          setTimeout(() => alive && setState("ready"), 350);
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
      <div className="explore-hint">scroll to zoom · drag to look around · esc to return</div>
    </div>
  );
}
