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

test("Instagram preflight accepts supported codec, frame-rate boundaries and optional AAC audio", async () => {
  const { validateInstagramFormat } = await import("../src/server/media.ts");
  assert.equal(typeof validateInstagramFormat, "function");
  const video = { codec_type: "video", codec_name: "h264", width: 1080, avg_frame_rate: "30000/1001" };
  for (const rate of ["23/1", "60/1", "30000/1001", "60000/1001"]) {
    assert.doesNotThrow(() => validateInstagramFormat({ streams: [{ ...video, avg_frame_rate: rate }] }));
  }
  assert.doesNotThrow(() => validateInstagramFormat({ streams: [{ ...video, bit_rate: "25000000" }] }));
  assert.doesNotThrow(() => validateInstagramFormat({ streams: [{ ...video, bit_rate: "N/A" }] }));
  assert.doesNotThrow(() => validateInstagramFormat({ streams: [{ ...video, codec_name: "hevc" }, { codec_type: "audio", codec_name: "aac", sample_rate: "48000" }] }));
  for (const stream of [
    { ...video, codec_name: "mpeg4" }, { ...video, codec_name: "av1" },
    { ...video, width: 1921 }, { ...video, avg_frame_rate: "22/1" },
    { ...video, avg_frame_rate: "61/1" }, { ...video, avg_frame_rate: "0/0" },
    { ...video, avg_frame_rate: "30000/0" }, { ...video, avg_frame_rate: "bad" },
    { ...video, bit_rate: "25000001" },
  ]) assert.throws(() => validateInstagramFormat({ streams: [stream] }));
  for (const audio of [
    { codec_type: "audio", codec_name: "mp3", sample_rate: "48000" },
    { codec_type: "audio", codec_name: "aac", sample_rate: "44100" },
  ]) assert.throws(() => validateInstagramFormat({ streams: [video, audio] }));
  assert.throws(() => validateInstagramFormat({ streams: [] }));
});
