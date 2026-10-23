/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Google Maps Platform browser key with the Maps JavaScript API enabled; enables the look-around view. */
  readonly VITE_GOOGLE_MAPS_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
