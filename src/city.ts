/**
 * The city this build is for. Filled in at build time by the city plugin in vite.config.ts from
 * cities/<VITE_CITY>/city.json, so one bundle is one city and the data folder matches.
 */
export type City = {
  slug: string;
  name: string;
  domain: string;
  headline: string;
  /** The "Built from …" credits line, sources separated by " · ". */
  credits: string;
};

declare const __CITY__: City;
declare const __BUILD__: string;

/** Commit and time of this build; on the <html> element as data-build and printed once in the console. */
export const build: string = __BUILD__;

export const city: City = __CITY__;
