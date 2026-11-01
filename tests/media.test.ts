import { test } from "node:test";
import assert from "node:assert/strict";
import { validateVideoMetadata } from "../src/server/media.ts";
test("vertical video metadata requires finite positive dimensions and bounded duration", () => {
  const valid = {
    streams: [{ codec_type: "video", width: 1080, height: 1920 }],
    format: { duration: "60" },
  };
  assert.deepEqual(validateVideoMetadata(valid), {
    width: 1080,
    height: 1920,
    duration: 60,
  });
  for (const input of [
    null,
    {},
    { streams: [], format: { duration: "60" } },
    ...[
      { width: 0, height: 1920 },
      { width: 1080, height: 0 },
      { width: 1920, height: 1080 },
      { width: 1080, height: 1080 },
      { width: "1080", height: 1920 },
      { width: 1080, height: Infinity },
    ].map((size) => ({
      streams: [{ codec_type: "video", ...size }],
      format: { duration: "60" },
    })),
    ...["NaN", "0", "2.99", "180.01", "Infinity"].map((duration) => ({
      ...valid,
      format: { duration },
    })),
  ])
    assert.throws(() => validateVideoMetadata(input));
  assert.equal(
    validateVideoMetadata({ ...valid, format: { duration: "3" } }).duration,
    3,
  );
  assert.equal(
    validateVideoMetadata({ ...valid, format: { duration: "180" } }).duration,
    180,
  );
});
