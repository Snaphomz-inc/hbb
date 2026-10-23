import type { StyleSpecification } from "maplibre-gl";

/**
 * Keyless base map: Esri World Imagery draped on AWS terrain tiles, with
 * OpenFreeMap's building footprints extruded on top so the aerial view reads
 * as a city, not a flat photo. Swap `satellite` for another raster source
 * (or the whole style for Google's photorealistic tiles) without touching
 * the story code.
 */
export const SATELLITE_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
export const TERRAIN_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
export const VECTOR_URL = "https://tiles.openfreemap.org/planet";
export const GLYPHS_URL = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";

export function baseStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: GLYPHS_URL,
    sources: {
      satellite: {
        type: "raster",
        tiles: [SATELLITE_URL],
        tileSize: 256,
        maxzoom: 19,
        attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
      },
      terrain: {
        type: "raster-dem",
        tiles: [TERRAIN_URL],
        tileSize: 256,
        encoding: "terrarium",
        maxzoom: 15,
        attribution: "Terrain: Mapzen, USGS, AWS",
      },
      openmaptiles: {
        type: "vector",
        url: VECTOR_URL,
        attribution: "© OpenFreeMap © OpenMapTiles © OpenStreetMap contributors",
      },
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": "#0b1220" } },
      {
        id: "satellite",
        type: "raster",
        source: "satellite",
        paint: { "raster-saturation": -0.12, "raster-contrast": 0.05, "raster-brightness-max": 0.96 },
      },
      {
        id: "buildings",
        type: "fill-extrusion",
        source: "openmaptiles",
        "source-layer": "building",
        minzoom: 13,
        paint: {
          "fill-extrusion-color": "#e9e4d8",
          "fill-extrusion-height": ["coalesce", ["get", "render_height"], 6],
          "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
          // Hidden during the story; raiseBuildings() in MapScene grows them on the way into look-around.
          "fill-extrusion-opacity": 0,
          "fill-extrusion-opacity-transition": { duration: 600, delay: 0 },
          "fill-extrusion-vertical-gradient": true,
        },
      },
      {
        id: "water-names",
        type: "symbol",
        source: "openmaptiles",
        "source-layer": "water_name",
        minzoom: 11,
        layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Italic"], "text-size": 13 },
        paint: { "text-color": "#dbeafe", "text-halo-color": "#0b1220", "text-halo-width": 1 },
      },
    ],
    terrain: { source: "terrain", exaggeration: 1.25 },
    sky: {
      "sky-color": "#7fb0e4",
      "horizon-color": "#dfe9f3",
      "fog-color": "#f3f6fa",
      "sky-horizon-blend": 0.6,
      "horizon-fog-blend": 0.75,
      "fog-ground-blend": 0.55,
      "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 10, 1, 12, 0.6],
    },
  };
}
