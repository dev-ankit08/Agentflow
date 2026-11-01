/**
 * Minimal 5-field cron (minute hour day-of-month month day-of-week), evaluated in UTC.
 * Supports *, lists (1,15), ranges (1-5), steps (*\/15, 0-30/10). Day-of-week 0 or 7 is Sunday.
 */
const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
] as const;

export type Cron = { sets: Set<number>[]; domStar: boolean; dowStar: boolean };

function parseField(src: string, min: number, max: number, name: string): Set<number> {
  const out = new Set<number>();
  for (const part of src.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`Invalid ${name}: "${part}"`);
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) throw new Error(`Invalid step in ${name}`);
    let lo = min;
    let hi = max;
    if (m[1] !== "*") {
      const [a, b] = m[1]!.split("-").map(Number);
      lo = a!;
      hi = b ?? (m[2] ? max : a!);
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`${name} must be between ${min} and ${max}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("A schedule needs 5 fields: minute hour day-of-month month day-of-week");
  const sets = parts.map((p, i) => parseField(p, FIELDS[i]!.min, FIELDS[i]!.max, FIELDS[i]!.name));
  if (sets[4]!.has(7)) sets[4]!.add(0);
  return { sets, domStar: parts[2] === "*", dowStar: parts[4] === "*" };
}

/** True when the schedule fires in the minute containing `date` (UTC). */
export function cronMatches(cron: Cron, date: Date): boolean {
  const [min, hour, dom, month, dow] = cron.sets as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  if (!min.has(date.getUTCMinutes()) || !hour.has(date.getUTCHours()) || !month.has(date.getUTCMonth() + 1))
    return false;
  // Standard cron: when both day fields are restricted, either may match.
  const domOk = dom.has(date.getUTCDate());
  const dowOk = dow.has(date.getUTCDay());
  if (cron.domStar && cron.dowStar) return true;
  if (cron.domStar) return dowOk;
  if (cron.dowStar) return domOk;
  return domOk || dowOk;
}

/** The next time (UTC, whole minute) after `from` when the schedule fires, within a year. */
export function nextCronRun(cron: Cron, from: Date): Date | null {
  const d = new Date(from);
  d.setUTCSeconds(0, 0);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    d.setUTCMinutes(d.getUTCMinutes() + 1);
    if (cronMatches(cron, d)) return new Date(d);
  }
  return null;
}
