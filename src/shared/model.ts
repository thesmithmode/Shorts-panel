export const PLATFORMS = ["youtube", "instagram", "tiktok"] as const;
export type Platform = (typeof PLATFORMS)[number];
export type DeliveryState =
  | "pending"
  | "processing"
  | "published"
  | "failed"
  | "blocked"
  | "unknown";
export interface Video {
  id: string;
  title: string;
  hashtags: string;
  filename: string;
  bytes: number;
  createdAt: number;
  position: number;
  scheduledAt: number | null;
  pinned: boolean;
  kind: "content" | "extra";
  state: "queued" | "dispatched" | "published";
  deletedAt: number | null;
}
export interface Delivery {
  videoId: string;
  platform: Platform;
  state: DeliveryState;
  originalAt: number;
  nextAt: number;
  successAt: number | null;
  externalId: string | null;
  url: string | null;
  error: string | null;
  attempts: number;
}
export interface Connection {
  platform: Platform;
  configured: boolean;
  connected: boolean;
  account: string | null;
  expiresAt: number | null;
  message: string;
}
export interface Snapshot {
  videos: (Video & { deliveries: Delivery[] })[];
  connections: Connection[];
  storage: { free: number; used: number; reserve: number; budget: number; orphaned: number; orphanedBytes: number; missing: number };
  csrf: string;
}
