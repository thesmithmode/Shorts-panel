import { openSync, closeSync, readSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface VideoMetadata {
  width: number;
  height: number;
  duration: number;
}
export class VideoValidationError extends Error {}
type MediaStream = { codec_type?: unknown; codec_name?: unknown; width?: unknown; height?: unknown; avg_frame_rate?: unknown; sample_rate?: unknown; bit_rate?: unknown };
type MediaInput = { streams?: MediaStream[]; format?: { duration?: unknown } };
/** Treat ffprobe output as untrusted input; absent dimensions are not vertical video. */
export function validateVideoMetadata(value: unknown): VideoMetadata {
  const input = value as MediaInput | null;
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
    throw new VideoValidationError("Нужно вертикальное видео от 3 до 180 секунд");
  return { width, height, duration };
}
/** Meta's documented Reel upload constraints; never silently transcode an original. */
export function validateInstagramFormat(value: unknown): void {
  const input = value as MediaInput | null;
  const streams = Array.isArray(input?.streams) ? input.streams : [];
  const video = streams.find((stream) => stream?.codec_type === "video");
  if (!video || (video.codec_name !== "h264" && video.codec_name !== "hevc"))
    throw new VideoValidationError("Instagram принимает видео H.264 или H.265 (HEVC).");
  if (typeof video.width !== "number" || video.width > 1920)
    throw new VideoValidationError("Ширина видео для Instagram не должна превышать 1920 пикселей.");
  const match = typeof video.avg_frame_rate === "string" ? /^(\d+)\/(\d+)$/.exec(video.avg_frame_rate) : null;
  const fps = match && Number(match[2]) ? Number(match[1]) / Number(match[2]) : NaN;
  if (!Number.isFinite(fps) || fps < 23 || fps > 60)
    throw new VideoValidationError("Частота кадров для Instagram должна быть от 23 до 60 FPS.");
  if (typeof video.bit_rate === "string" && /^\d+$/.test(video.bit_rate) && Number(video.bit_rate) > 25_000_000)
    throw new VideoValidationError("Битрейт видео для Instagram не должен превышать 25 Мбит/с.");
  if (streams.some((stream) => stream?.codec_type === "audio" && (stream.codec_name !== "aac" || stream.sample_rate !== "48000")))
    throw new VideoValidationError("Звук для Instagram должен быть AAC с частотой 48 кГц.");
}
/** Shared file validation for new uploads and explicitly recovered originals. */
export async function inspectVideoFile(path: string): Promise<VideoMetadata> {
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(12);
    if (readSync(fd, head, 0, 12, 0) !== 12 || head.toString("ascii", 4, 8) !== "ftyp")
      throw new VideoValidationError("Нужен корректный MP4-файл.");
  } finally { closeSync(fd); }
  const probe = await promisify(execFile)("ffprobe", [
    "-v", "error", "-protocol_whitelist", "file", "-show_entries",
    "stream=codec_type,codec_name,width,height,avg_frame_rate,sample_rate,bit_rate:format=duration", "-of", "json", path,
  ], { timeout: 15_000, maxBuffer: 64 * 1024 });
  const metadata = JSON.parse(probe.stdout);
  const result = validateVideoMetadata(metadata);
  validateInstagramFormat(metadata);
  return result;
}
