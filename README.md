# Neighborhood aerial view

A scroll-driven 3D flyover of a neighborhood that answers a homebuyer's questions
as the camera moves: what homes sell for, where prices are heading, what is within
reach, where the kids would go to school, what the risks are, and what is being
built. Modelled on the "physical intelligence" flyover at ageospatial.com, but for
a whole neighborhood and from real public and MLS data instead of a hand-made scene.

43 Los Angeles neighborhoods are built, grouped by region (Westside; Beverly Hills and
West Hollywood; San Fernando Valley; Glendale, Burbank and the foothills; South Bay).
Add one by appending to `scripts/neighborhoods.json` and rerunning the data build;
`"byZip": true` narrows an MLS city (the City of Los Angeles) to the listed ZIPs.
A full rebuild makes a few hundred requests and takes about ten minutes; cached
responses make later runs free, and `--skip-existing` resumes an interrupted run.

The front door (`#/`) is a county overview: every neighborhood on one map, coloured by
median price and listed by region; click a dot or a row to fly into its story
(`#/venice`, `#/glendale`, ...).

## Run it

```bash
npm install
npm run data      # builds public/data/*.json (needs the CMA database, see below)
npm run dev       # http://localhost:5190
```

`npm run build` type-checks and writes a static site to `dist/`; it has no backend
and can be hosted anywhere (the data files are plain JSON next to the page, about
1 MB per neighborhood, loaded one at a time). To serve it under a sub-path, build
with `VITE_BASE=/neighborhoods/ npm run build`. Neighborhoods are addressed by hash
(`#/venice`), so no server-side routing is needed.

## How it works

- **Map.** MapLibre GL with a keyless base: Esri World Imagery draped over AWS
  terrain tiles, OpenFreeMap building footprints extruded on top, sky and fog.
  Nothing needs an API key. The base style lives in `src/map/style.ts`; swapping
  it for Google's photorealistic 3D tiles (needs a key with the Map Tiles API) or
  another satellite source does not touch the story.
- **Story.** `src/story/chapters.ts` turns a neighborhood's data file into
  chapters: a question, a headline, a camera (centre, zoom offset, pitch, bearing),
  the map layers to show, map-pinned labels and the stat cards. The page is a stack
  of empty spacer sections; scroll position maps onto the chapters
  (`useScrollStory.ts`), the camera interpolates between chapter cameras every
  frame with a slow drift, labels follow their coordinates (`Labels.tsx`), and
  layers fade in and out through paint-property transitions (`MapScene.tsx`).
- **Data.** `scripts/build_neighborhood.py` writes one JSON per neighborhood from:
  - the cleaned CMA database `parcel-package/re_superapp/data/cma-local.db`
    (closed sales and leases from the MLS feed, the California school directory,
    LAUSD attendance zones, City of Los Angeles permits, the DOT noise grid);
  - the link analyser's `dev.db` for the FHFA price index and the Freddie Mac rate;
  - free services: OpenStreetMap (Overpass) for places and park outlines, FEMA's
    flood layer, CAL FIRE severity zones, the California Geological Survey's
    liquefaction, landslide and fault zones, EPA's walkability index, and Census
    Reporter for ACS figures by ZIP.

  Responses are cached in `scripts/cache/` so rebuilds are free; `--offline` builds
  from the cache alone. A source that fails is written as null and the page omits
  that figure rather than showing a false "none".

## What is deliberately left out

- Crime: no free sub-county source, and a fair-housing concern in a ranking context.
- School ratings: the free sources checked earlier looked unreliable; counts and
  enrollment only.
- Live listings: the sales layer is closed sales, which the MLS feed cannot give
  for a whole neighborhood without a paid request per home.

## Before production

- **Imagery licence.** The satellite base is Esri World Imagery pulled from the public
  tile endpoint, which Esri intends for ArcGIS customers. For a public Snaphomz page,
  either use the Google photorealistic 3D tiles (needs a company key with the Map
  Tiles API enabled, billed per tileset load) or a licensed satellite source such as
  Mapbox or MapTiler. Swapping is one file: `src/map/style.ts`.
- **Data refresh.** Sales are a one-off extract; rerun `npm run data` when the data
  team delivers a new batch. Everything else is cached and refetched only when the
  cache is cleared.
- **Phone layout** has been styled but should be checked on a real device.

## Motion borrowed from Atlas

Three ideas from the Atlas After Effects plugin, rebuilt live in MapLibre:

- **Sales as timed events.** The homes chapter plays the year: each sale lands in its 30-day
  bucket with a pulse ring, and a ticker under the legend shows the month, its count and median.
  Driven by feature state (`setSalesClock`), so nothing is re-tiled per frame.
- **Heat.** The trend chapter shows dollar volume of sales as a heatmap under the buildings.
- **Journeys.** A "How far is everything?" chapter draws the driving routes to Downtown LA, LAX
  and the nearer of the Santa Monica and Manhattan Beach piers along real streets, with times
  and distances. Routes come from the public OSRM demo server at build time (no traffic; cached
  like every other fetch) and are stored in each neighborhood file as `routes`.

All three stop under `prefers-reduced-motion`.

## Look around (Google 3D)

With `VITE_GOOGLE_MAPS_KEY` set in `.env` (see `.env.example`; a Google Maps Platform browser
key with the Maps JavaScript API enabled), the story gains a quiet way out of the rails: click the
map, or the small "look around" pill at the bottom right. Google's photorealistic 3D mesh fades in
on exactly the camera the story was showing (same centre, distance, tilt and heading), the page
stops scrolling, and the wheel zooms while dragging turns. "Back to the story" or Esc fades Google
out and the story camera glides from wherever you left off back to its chapter. On the way in, while Google loads, the story camera dives for three seconds, halving its
distance, tilting toward the horizon and wheeling a little, and Google's mesh fades in on the
view it lands on, the mirror of the glide back out. Without the key nothing changes and the pill is not rendered. Each entry is one Google 3D map load for billing.

## Deploying (la.snaphomz.com)

The site is static, so it ships the same way as the other Snaphomz static sites: a private S3
bucket behind CloudFront, with the certificate and the Route 53 alias managed by the CDK stack
in `cdk/` (`LaSiteStack`, us-east-1, existing `snaphomz.com` hosted zone).

`.github/workflows/deploy.yml` runs on every push to `main` (or by hand from the Actions tab):
build, `cdk deploy`, sync `dist/` to the bucket, invalidate CloudFront, then curl the site.
Hashed assets are uploaded as immutable; `index.html` and the `data/*.json` files revalidate.
It authenticates through the organisation's GitHub OIDC role, which only trusts `main`, so a
push to any other branch builds nothing and deploys nothing.

One repository secret is needed for the Google 3D look-around: `VITE_GOOGLE_MAPS_KEY`, a
browser key with the Maps JavaScript API enabled and its HTTP referrer restricted to
`https://la.snaphomz.com/*`. Without it the build still succeeds and the feature is absent.

Before a wide release, swap the Esri World Imagery base in `src/map/style.ts` for licensed
imagery; the public Esri endpoint is not licensed for production.

## Export for After Effects (Atlas)

`npm run export:atlas` writes `exports/atlas/` (git-ignored) from the built data: one GeoJSON
of neighborhood points (name, region, median price, sales, camera), one of their bounding
boxes, and CSVs of sales (with an approximate date, to the 30-day bucket), permit points and
schools, each with `lat`/`lon` columns. These are the formats the Atlas plugin for After
Effects imports: drop the GeoJSON in for pins, labels and areas, and the sales CSV into
Atlas Particles as timed events or a heat layer. Rendered video from Atlas can sit next to
the live site (a promo film, a per-neighborhood clip) but cannot replace it: Atlas renders
frames inside After Effects and has no interactive or web output.

## Known limits

- Permits cover the City of Los Angeles only; cities that issue their own (Santa
  Monica, Beverly Hills, Burbank, Glendale, Torrance, the beach cities) get no
  permits chapter.
- Sales are the last 12 months as delivered by the data team, deduplicated across
  boards; a few closings are mis-geocoded and are trimmed by a percentile box.
- The extruded buildings are OpenStreetMap footprints with estimated heights, not
  photogrammetry; the satellite base is 2D imagery on terrain.
