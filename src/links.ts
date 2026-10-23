/** Links into the main Snaphomz site, the same for every city. */
export const SNAPHOMZ = "https://www.snaphomz.com";

/**
 * A listing by its listing id (the id the sales extract carries). The main site redirects this
 * form to the listing's canonical address page, and it is the form the site itself links with.
 */
export function listingUrl(listingId: string): string {
  return `${SNAPHOMZ}/buy/${encodeURIComponent(listingId)}/prop/preview`;
}

/** The main site's page for a neighborhood; our slugs match its slugs. */
export function homesUrl(slug: string): string {
  return `${SNAPHOMZ}/homes/${encodeURIComponent(slug)}`;
}
