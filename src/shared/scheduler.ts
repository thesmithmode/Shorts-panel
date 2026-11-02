import type { Video, Delivery, Platform } from "./model.ts";
export const DAY = 86_400_000;
export const HOUR = 3_600_000;
export const MOSCOW = 3 * HOUR;
export function dayStart(time: number): number {
  return Math.floor((time + MOSCOW) / DAY) * DAY - MOSCOW;
}
export function at(day: number, hour: number): number {
  return day + hour * HOUR;
}
export function moscowDate(time: number): string {
  return new Date(time + MOSCOW).toISOString().slice(0, 10);
}
export function parseMoscow(value: string): number {
  const n = Date.parse(value + ":00+03:00");
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ||
    !Number.isFinite(n) ||
    new Date(n + MOSCOW).toISOString().slice(0, 16) !== value
  )
    throw new Error("Некорректное время");
  return n;
}
const HOURS = [6, 12, 17];
/** Stable queue order; fixed posts count towards coverage except extras. */
export function plan(
  videos: Video[],
  now: number,
  preserveHead = true,
): Map<string, number> {
  const result = new Map<string, number>();
  const automatic = videos
    .filter((v) => v.state === "queued" && !v.pinned)
    .sort(
      (a, b) =>
        a.position - b.position ||
        a.createdAt - b.createdAt ||
        a.id.localeCompare(b.id),
    );
  const fixed = videos.filter(
    (v) => v.scheduledAt !== null && (v.pinned || v.state !== "queued"),
  );
  const today = dayStart(now);
  const first = HOURS.some((h) => at(today, h) > now) ? today : today + DAY;
  const manualToday = fixed.some(
    (v) =>
      v.pinned && v.kind === "content" && dayStart(v.scheduledAt!) === today,
  );
  let protectedVideo = automatic[0];
  if (
    preserveHead &&
    protectedVideo?.scheduledAt &&
    protectedVideo.scheduledAt > now &&
    !(manualToday && dayStart(protectedVideo.scheduledAt) === today)
  ) {
    result.set(protectedVideo.id, protectedVideo.scheduledAt);
  }
  const anchors = fixed.map((v) => ({
    time: v.scheduledAt!,
    counts: v.kind === "content",
  }));
  if (protectedVideo && result.has(protectedVideo.id))
    anchors.push({ time: protectedVideo.scheduledAt!, counts: true });
  const days: {
    day: number;
    slots: number[];
    count: number;
    assigned: number;
  }[] = [];
  const remaining = automatic.filter((v) => !result.has(v.id));
  const earliest =
    protectedVideo && result.has(protectedVideo.id)
      ? result.get(protectedVideo.id)!
      : now;
  const planningStart = Math.max(first, dayStart(earliest));
  const countDays = 7 + Math.ceil((remaining.length + fixed.length) / 3) + 2;
  for (let i = 0; i < countDays; i++) {
    const day = planningStart + i * DAY;
    const onDay = anchors.filter((a) => dayStart(a.time) === day);
    const fixedTimes = onDay.map((a) => a.time);
    days.push({
      day,
      slots: HOURS.map((h) => at(day, h)).filter(
        (t) => t > earliest && !fixedTimes.includes(t),
      ),
      count: onDay.filter((a) => a.counts).length,
      assigned: 0,
    });
  }
  let left = remaining.length;
  for (let level = 1; level <= 3; level++)
    for (const d of days.slice(0, 7)) {
      if (left && d.count + d.assigned < level && d.assigned < d.slots.length) {
        d.assigned++;
        left--;
      }
    }
  for (const d of days.slice(7))
    while (left && d.assigned < d.slots.length && d.count + d.assigned < 3) {
      d.assigned++;
      left--;
    }
  const times: number[] = [];
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    if (!d.assigned) continue;
    let chosen = d.slots.slice(0, d.assigned);
    if (i < 7 && d.count + d.assigned === 2) {
      const desired = [at(d.day, 6), at(d.day, 17)].filter((t) =>
        d.slots.includes(t),
      );
      if (desired.length >= d.assigned) chosen = desired.slice(0, d.assigned);
      else if (d.assigned === 1 && d.slots.includes(at(d.day, 17)))
        chosen = [at(d.day, 17)];
    }
    times.push(...chosen);
  }
  times.sort((a, b) => a - b);
  remaining.forEach((v, i) => {
    if (times[i] !== undefined) result.set(v.id, times[i]);
  });
  return result;
}
export function deletionAt(deliveries: Delivery[]): number | null {
  if (
    !(["youtube", "instagram", "tiktok"] as const).every((p) =>
      deliveries.some(
        (d) =>
          d.platform === p && d.state === "published" && d.successAt !== null,
      ),
    )
  )
    return null;
  return Math.max(...deliveries.map((d) => d.successAt ?? 0)) + DAY;
}
export function recoveryAt(
  original: number,
  now: number,
  platform: Platform,
  videos: Video[],
  deliveries: Delivery[],
): number {
  if (now < original + HOUR) return now;
  const occupied = new Set(
    videos.filter((v) => v.scheduledAt !== null).map((v) => v.scheduledAt!),
  );
  for (const d of deliveries)
    if (d.platform === platform && d.state !== "published")
      occupied.add(d.nextAt);
  for (let day = dayStart(now); ; day += DAY)
    for (const hour of [1, 6, 12, 17]) {
      const time = at(day, hour);
      if (time > now && !occupied.has(time)) return time;
    }
}
