import type { Video, Delivery, Platform } from "../shared/model.ts";
/** No publication request was made, so retrying cannot create a duplicate. */
export class RetryableBeforeSend extends Error {}
/** Queue persistence needed by the worker, independent of SQLite implementation. */
export interface QueueRepository {
  readonly dir: string;
  videos(): Video[];
  deliveries(): Delivery[];
  video(video: Video): void;
  delivery(delivery: Delivery): void;
  transaction<T>(operation: () => T): T;
}
/** Publishing capabilities used by the worker; OAuth configuration is not its concern. */
export interface PublicationGateway {
  connections(): { platform: Platform; connected: boolean }[];
  canRecover?(delivery: Delivery): boolean;
  publish(video: Video, delivery: Delivery): Promise<void>;
  verifyYoutube(delivery: Delivery): Promise<void>;
}
export type Clock = () => number;
