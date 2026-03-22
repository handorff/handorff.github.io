export const DEBUG_SOURCE_KEYS = ["vehicles", "routes", "stops", "trips"] as const;

export type DebugSourceKey = (typeof DEBUG_SOURCE_KEYS)[number];

export function isDebugModeEnabled(search: string): boolean {
  return new URLSearchParams(search).get("debug") === "true";
}

export function formatDebugTimestamp(
  value: Date | null,
  locales?: string | string[],
  timeZone?: string
): string {
  if (!value) {
    return "Not loaded";
  }

  return new Intl.DateTimeFormat(locales, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    ...(timeZone ? { timeZone } : {})
  }).format(value);
}
