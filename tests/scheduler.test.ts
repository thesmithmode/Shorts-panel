import { test } from "node:test";
import assert from "node:assert/strict";
import {
  plan,
  DAY,
  HOUR,
  at,
  dayStart,
  deletionAt,
  recoveryAt,
  parseMoscow,
} from "../src/shared/scheduler.ts";
import type { Video, Delivery } from "../src/shared/model.ts";
const monday = parseMoscow("2026-11-02T00:00");
function videos(count: number): Video[] {
  return Array.from({ length: count }, (_, i) => ({
    id: String(i),
    title: String(i),
    hashtags: "",
    filename: `${i}.mp4`,
    bytes: 100,
    createdAt: i,
    position: i,
    scheduledAt: null,
    pinned: false,
    kind: "content",
    state: "queued",
    deletedAt: null,
  }));
}
for (const [n, expected] of [
  [7, [1, 1, 1, 1, 1, 1, 1]],
  [8, [2, 1, 1, 1, 1, 1, 1]],
  [9, [2, 2, 1, 1, 1, 1, 1]],
  [14, [2, 2, 2, 2, 2, 2, 2]],
  [15, [3, 2, 2, 2, 2, 2, 2]],
  [18, [3, 3, 3, 3, 2, 2, 2]],
  [21, [3, 3, 3, 3, 3, 3, 3]],
] as const)
  test(`${n} videos cover seven days evenly`, () => {
    const v = videos(n),
      p = plan(v, monday);
    const counts = Array.from(
      { length: 7 },
      (_, i) =>
        [...p.values()].filter((t) => dayStart(t) === monday + i * DAY).length,
    );
    assert.deepEqual(counts, expected);
    const times = v.map((v) => p.get(v.id)!);
    assert.deepEqual(
      times,
      [...times].sort((a, b) => a - b),
    );
    assert.equal(new Set(times).size, n);
  });
test("two posts use 06 and 17; overflow is tightly packed", () => {
  const p = plan(videos(23), monday);
  assert.equal(p.get("0"), at(monday, 6));
  assert.equal(p.get("21"), at(monday + 7 * DAY, 6));
  assert.equal(p.get("22"), at(monday + 7 * DAY, 12));
  const two = plan(videos(8), monday);
  assert.equal(two.get("1"), at(monday, 17));
});
test("partial today and sequential uploads preserve head and order", () => {
  const v = videos(7);
  let p = plan(v, at(monday, 13));
  for (const x of v) x.scheduledAt = p.get(x.id)!;
  v.push({ ...videos(1)[0], id: "new", position: 9 });
  p = plan(v, at(monday, 13) + 1000);
  assert.equal(p.get("0"), at(monday, 17));
  assert.ok(p.get("new")! > p.get("6")!);
  assert.equal(dayStart(p.get("1")!), monday + DAY);
});
test("published today and content pin cover today; ads do not", () => {
  const v = videos(2);
  v[0] = { ...v[0], state: "published", scheduledAt: at(monday, 6) };
  assert.equal(plan(v, at(monday, 10)).get("1"), at(monday + DAY, 6));
  v[0] = {
    ...v[0],
    state: "queued",
    pinned: true,
    scheduledAt: at(monday, 15.5),
  };
  v[1].scheduledAt = at(monday, 17);
  assert.equal(plan(v, at(monday, 10)).get("1"), at(monday + DAY, 6));
  v[0].kind = "extra";
  assert.equal(plan(v, at(monday, 10)).get("1"), at(monday, 17));
});
test("a protected head at noon is not moved for the 06/17 template", () => {
  const v = videos(8);
  v[0].scheduledAt = at(monday, 12);
  const p = plan(v, at(monday, 8));
  assert.equal(p.get("0"), at(monday, 12));
  assert.ok([...p.values()].every((t) => t >= at(monday, 12)));
});
test("sliding window stretches nine remaining videos", () => {
  const v = videos(9);
  v.forEach(
    (v, i) =>
      (v.scheduledAt = at(
        monday + Math.floor(i / 3) * DAY,
        [6, 12, 17][i % 3],
      )),
  );
  const p = plan(v, monday);
  assert.deepEqual(
    Array.from(
      { length: 7 },
      (_, i) =>
        [...p.values()].filter((t) => dayStart(t) === monday + i * DAY).length,
    ),
    [2, 2, 1, 1, 1, 1, 1],
  );
});
function deliveries(): Delivery[] {
  return ["youtube", "instagram", "tiktok"].map((platform, i) => ({
    videoId: "0",
    platform: platform as Delivery["platform"],
    state: "published",
    originalAt: monday,
    nextAt: monday,
    successAt: monday + i * HOUR,
    externalId: "id",
    url: null,
    error: null,
    attempts: 1,
  }));
}
test("deletion requires all distinct platform successes plus 24h", () => {
  const ds = deliveries();
  assert.equal(deletionAt(ds), monday + 2 * HOUR + DAY);
  ds[2].state = "failed";
  assert.equal(deletionAt(ds), null);
  assert.equal(deletionAt([ds[0], ds[0], ds[1]]), null);
});
test("grace hour ends exactly at 13:00; missed post can use next 01:00", () => {
  const original = at(monday, 12);
  assert.equal(
    recoveryAt(original, at(monday, 12) + 59 * 60_000, "tiktok", [], []),
    at(monday, 12) + 59 * 60_000,
  );
  const v = videos(1);
  v[0].scheduledAt = at(monday, 17);
  assert.equal(
    recoveryAt(original, at(monday, 13), "tiktok", v, []),
    at(monday + DAY, 1),
  );
});
test("property: capacity, order and no past assignments for 1..100 videos at each hour", () => {
  for (let h = 0; h < 24; h++)
    for (let n = 1; n <= 100; n++) {
      const now = at(monday, h) + 1000;
      const v = videos(n),
        p = plan(v, now);
      const times = v.map((x) => p.get(x.id)!);
      assert.equal(p.size, n);
      assert.equal(new Set(times).size, n);
      assert.deepEqual(
        times,
        [...times].sort((a, b) => a - b),
      );
      assert.ok(times.every((t) => t > now));
      for (const d of new Set(times.map(dayStart)))
        assert.ok(times.filter((t) => dayStart(t) === d).length <= 3);
    }
});

test("head at 17:00 never spills earlier unavailable slots onto an already filled day", () => {
  const v = videos(9);
  v[0].scheduledAt = at(monday, 17);
  v[8].pinned = true;
  v[8].scheduledAt = at(monday + DAY, 15.5);
  const p = plan(v, monday);
  const all = [...p.values(), v[8].scheduledAt];
  assert.deepEqual(
    Array.from(
      { length: 7 },
      (_, i) => all.filter((t) => dayStart(t) === monday + i * DAY).length,
    ),
    [1, 2, 2, 1, 1, 1, 1],
  );
  assert.equal(new Set(all).size, 9);
});
