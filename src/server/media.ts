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
