// SLA calculation logic. All dates handled in Europe/London since the cut-off
// is local-time. Mintsoft timestamps come back without timezone info; we
// assume they're UK local (which is how Mintsoft customers see them).

const UK_TZ = "Europe/London";

export const WAREHOUSE_CUTOFF_HOUR = Number(process.env.WAREHOUSE_CUTOFF_HOUR ?? 13);
export const WAREHOUSE_CUTOFF_MINUTE = Number(process.env.WAREHOUSE_CUTOFF_MINUTE ?? 0);
export const DPD_DELIVERY_SLA_DAYS = Number(process.env.DPD_DELIVERY_SLA_DAYS ?? 1);

interface UKDateParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0=Sun..6=Sat
}

function toUKParts(input: string | Date): UKDateParts | null {
  if (!input) return null;
  // Mintsoft sends "2026-05-25 08:26:46" or ISO. Treat naive strings as UK local.
  let d: Date;
  if (input instanceof Date) {
    d = input;
  } else {
    const s = String(input);
    // If no timezone marker, treat as UK local by appending Europe/London offset.
    // The safest way: format with Intl into UK parts directly.
    d = new Date(s.includes("T") || s.includes("Z") ? s : s.replace(" ", "T"));
  }
  if (Number.isNaN(d.getTime())) return null;

  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: UK_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "";
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: weekdayMap[get("weekday")] ?? 0,
  };
}

function isWorkingDay(weekday: number): boolean {
  return weekday >= 1 && weekday <= 5; // Mon-Fri
}

function dateNumber(p: UKDateParts): number {
  return p.year * 10000 + p.month * 100 + p.day;
}

function addWorkingDays(start: UKDateParts, n: number): number {
  let day = dateNumber(start);
  let weekday = start.weekday;
  let added = 0;
  while (added < n) {
    // Advance one calendar day (using Date arithmetic for correctness across month/year boundaries)
    const d = new Date(Date.UTC(start.year, start.month - 1, start.day));
    d.setUTCDate(d.getUTCDate() + (added + 1));
    weekday = d.getUTCDay();
    if (weekday >= 1 && weekday <= 5) {
      added += 1;
      day = d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
    }
  }
  return day;
}

function nextWorkingDay(p: UKDateParts): number {
  // Returns dateNumber of next working day strictly after p
  let d = new Date(Date.UTC(p.year, p.month - 1, p.day));
  while (true) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd >= 1 && wd <= 5) {
      return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
    }
  }
}

/** Expected dispatch date as YYYYMMDD number. */
export function expectedDispatchDateNumber(createdISO: string): number | null {
  const p = toUKParts(createdISO);
  if (!p) return null;
  if (isWorkingDay(p.weekday) && (p.hour < WAREHOUSE_CUTOFF_HOUR ||
        (p.hour === WAREHOUSE_CUTOFF_HOUR && p.minute <= WAREHOUSE_CUTOFF_MINUTE))) {
    return dateNumber(p);
  }
  return nextWorkingDay(p);
}

export function warehouseSlaMet(createdISO: string, dispatchedISO: string | null): boolean | null {
  if (!dispatchedISO) return null;
  const expected = expectedDispatchDateNumber(createdISO);
  if (expected == null) return null;
  const dp = toUKParts(dispatchedISO);
  if (!dp) return null;
  return dateNumber(dp) <= expected;
}

export function deliverySlaMet(dispatchedISO: string | null, deliveredISO: string | null, slaDays: number = DPD_DELIVERY_SLA_DAYS): boolean | null {
  if (!dispatchedISO || !deliveredISO) return null;
  const dp = toUKParts(dispatchedISO);
  const dl = toUKParts(deliveredISO);
  if (!dp || !dl) return null;
  const deadline = addWorkingDays(dp, slaDays);
  return dateNumber(dl) <= deadline;
}

export function transitHours(dispatchedISO: string | null, deliveredISO: string | null): number | null {
  if (!dispatchedISO || !deliveredISO) return null;
  const a = new Date(dispatchedISO.includes("T") ? dispatchedISO : dispatchedISO.replace(" ", "T"));
  const b = new Date(deliveredISO.includes("T") ? deliveredISO : deliveredISO.replace(" ", "T"));
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return (b.getTime() - a.getTime()) / 3600_000;
}

export function percentile(vals: number[], pct: number): number | null {
  if (vals.length === 0) return null;
  const s = [...vals].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const k = (s.length - 1) * (pct / 100);
  const f = Math.floor(k);
  const c = Math.min(f + 1, s.length - 1);
  return f === c ? s[f] : s[f] + (s[c] - s[f]) * (k - f);
}
