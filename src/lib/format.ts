export function money(value: number | null | undefined, compact = true): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (compact) {
    if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 2).replace(/\.?0+$/, "")}M`;
    if (Math.abs(value) >= 1_000) return `$${Math.round(value / 1_000)}K`;
  }
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

export function percent(value: number | null | undefined, digits = 0): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

export function signedPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const text = `${Math.abs(value * 100).toFixed(0)}%`;
  return value >= 0 ? `+${text}` : `−${text}`;
}

export function count(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return Math.round(value).toLocaleString("en-US");
}

export function days(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${Math.round(value)} days`;
}

export function monthName(iso: string): string {
  const [year, month] = iso.split("-").map(Number);
  return new Date(year, month - 1, 1).toLocaleString("en-US", { month: "short", year: "2-digit" });
}
