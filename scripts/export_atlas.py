"""Export the built neighborhood data as files the Atlas plugin for After Effects can import.

Atlas (aescripts.com/atlas) takes GeoJSON for pins, areas and labels, and CSV with
lat/lon/time columns for its Particles effect (events, heat, flows). This writes:

  exports/atlas/neighborhoods.geojson   one point per neighborhood: name, region, median price, sales, camera
  exports/atlas/neighborhood-areas.geojson  the bounding box of each neighborhood as a polygon
  exports/atlas/sales.csv               every closed sale of the last year, with an approximate date
  exports/atlas/permits.csv             building permit points (City of Los Angeles only)
  exports/atlas/schools.csv             schools with enrollment

Run from the package root after `npm run data`:  python -I scripts/export_atlas.py [--city la]
"""

from __future__ import annotations

import argparse
import csv
import json
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KIND = {0: "house", 1: "condo", 2: "other"}


def approx_date(built_at: str, months_ago: int) -> str:
    """The build keeps only 30-day buckets before the build date, so place each sale mid-bucket."""
    return (date.fromisoformat(built_at) - timedelta(days=months_ago * 30 + 15)).isoformat()


def main() -> None:
    parser = argparse.ArgumentParser(description="Export a city's built data as Atlas import files")
    parser.add_argument("--city", default="la", help="city folder under cities/ (default la)")
    city = parser.parse_args().city
    DATA = ROOT / "cities" / city / "data"
    OUT = ROOT / "exports" / "atlas" / city
    if not (DATA / "index.json").exists():
        raise SystemExit(f"no built data at {DATA}; run the data build first")
    OUT.mkdir(parents=True, exist_ok=True)
    index = json.loads((DATA / "index.json").read_text(encoding="utf-8"))
    points, areas = [], []
    sales_rows, permit_rows, school_rows = [], [], []

    for entry in index:
        hood = json.loads((DATA / f"{entry['slug']}.json").read_text(encoding="utf-8"))
        props = {
            "slug": hood["slug"],
            "name": hood["name"],
            "region": hood["region"],
            "tagline": hood["tagline"],
            "medianPrice": entry["medianPrice"],
            "sales": entry["sales"],
            "cameraBearing": hood["camera"]["bearing"],
            "cameraPitch": hood["camera"]["pitch"],
        }
        points.append({"type": "Feature", "properties": props, "geometry": {"type": "Point", "coordinates": hood["center"]}})
        (west, south), (east, north) = hood["bounds"]
        areas.append({
            "type": "Feature",
            "properties": {"slug": hood["slug"], "name": hood["name"], "region": hood["region"], "medianPrice": entry["medianPrice"]},
            "geometry": {"type": "Polygon", "coordinates": [[[west, south], [east, south], [east, north], [west, north], [west, south]]]},
        })
        for lon, lat, price, sqft, kind, beds, months_ago in hood["sales"]:
            sales_rows.append([hood["slug"], hood["name"], lat, lon, approx_date(hood["builtAt"], months_ago), price, sqft or "", KIND.get(kind, "other"), beds or ""])
        for lon, lat, label in (hood.get("permits") or {}).get("points", []):
            permit_rows.append([hood["slug"], hood["name"], lat, lon, label])
        for school in hood["schools"]:
            school_rows.append([hood["slug"], hood["name"], school["lat"], school["lon"], school["name"], school["level"], school["enrollment"] or ""])

    (OUT / "neighborhoods.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": points}, indent=1), encoding="utf-8")
    (OUT / "neighborhood-areas.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": areas}, indent=1), encoding="utf-8")

    def write_csv(name: str, header: list[str], rows: list[list]) -> None:
        with (OUT / name).open("w", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle)
            writer.writerow(header)
            writer.writerows(rows)

    sales_rows.sort(key=lambda row: row[4])
    write_csv("sales.csv", ["slug", "neighborhood", "lat", "lon", "date", "price", "sqft", "kind", "beds"], sales_rows)
    write_csv("permits.csv", ["slug", "neighborhood", "lat", "lon", "label"], permit_rows)
    write_csv("schools.csv", ["slug", "neighborhood", "lat", "lon", "school", "level", "enrollment"], school_rows)
    print(f"{len(points)} neighborhoods, {len(sales_rows)} sales, {len(permit_rows)} permits, {len(school_rows)} schools -> {OUT}")


if __name__ == "__main__":
    main()
