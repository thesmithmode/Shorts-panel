import { openSync, closeSync, readSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface VideoMetadata {
  width: number;
  height: number;
  duration: number;
}
/** Treat ffprobe output as untrusted input; absent dimensions are not vertical video. */
export function validateVideoMetadata(value: unknown): VideoMetadata {
  const input = value as {
    streams?: { codec_type?: unknown; width?: unknown; height?: unknown }[];
    format?: { duration?: unknown };
  } | null;
  const stream = Array.isArray(input?.streams)
    ? input.streams.find((s) => s?.codec_type === "video")
    : undefined;
  const width = stream?.width,
    height = stream?.height,
    duration = Number(input?.format?.duration);
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= width ||
    !Number.isFinite(duration) ||
    duration < 3 ||
    duration > 180
  )
    throw new Error("Нужно вертикальное видео от 3 до 180 секунд");
  return { width, height, duration };
}
/** Shared file validation for new uploads and explicitly recovered originals. */
export async function inspectVideoFile(path: string): Promise<VideoMetadata> {
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(12);
    if (readSync(fd, head, 0, 12, 0) !== 12 || head.toString("ascii", 4, 8) !== "ftyp")
      throw new Error("Не MP4");
  } finally { closeSync(fd); }
  const probe = await promisify(execFile)("ffprobe", [
    "-v", "error", "-protocol_whitelist", "file", "-show_entries",
    "stream=codec_type,width,height:format=duration", "-of", "json", path,
  ], { timeout: 15_000, maxBuffer: 64 * 1024 });
  return validateVideoMetadata(JSON.parse(probe.stdout));
}
