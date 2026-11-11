/**
 * Calls `onStill` whenever Google's camera has stopped moving, once per resting place. Google's
 * `gmp-steadychange` event is meant for this, but it does not fire for every wheel zoom or for a
 * camera set from code, and the pins and lot lines must follow the camera either way.
 */
type Camera3D = HTMLElement & { center: { lat: number; lng: number; altitude: number } | null; range: number; tilt: number; heading: number };

const SAMPLE_MS = 250;

export function watchStill(map3d: Camera3D, alive: () => boolean, onStill: () => void): () => void {
  let last: string | null = null;
  let reported: string | null = null;
  const id = setInterval(() => {
    if (!alive()) return;
    const centre = map3d.center;
    if (!centre) return;
    const key = [centre.lat.toFixed(6), centre.lng.toFixed(6), map3d.range.toFixed(1), map3d.tilt.toFixed(2), map3d.heading.toFixed(2)].join("|");
    if (key === last && key !== reported) {
      reported = key;
      onStill();
    }
    last = key;
  }, SAMPLE_MS);
  return () => clearInterval(id);
}
