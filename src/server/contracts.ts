import type { Video, Delivery, Platform } from "../shared/model.ts";
/** No publication request was made, so retrying cannot create a duplicate. */
export class RetryableBeforeSend extends Error {}
/** Existing external state can be checked safely before another publication request. */
export class RetryableSession extends Error {}
/** Retry-After applies to the whole platform, including other queued videos. */
export class RateLimited extends RetryableSession {
  constructor(public readonly retryAt: number) {
    super("Площадка ограничила частоту запросов. Ожидаем разрешённого времени повтора.");
  }
}
/** Local source is unavailable; no new publication was initiated by this attempt. */
export class SourceUnavailable extends Error {}
/** Explicit credential rejection; preserve external state and wait for reconnection. */
export class AccessRequired extends Error {
  constructor() {
    super("Доступ отозван или истёк. Повторно подключите аккаунт.");
  }
}
export class AccountMismatch extends AccessRequired {
  constructor() {
    super();
    this.message = "Подключён другой канал. Для незавершённых публикаций подключите исходный аккаунт.";
  }
}
export class ConnectionChanged extends AccessRequired {
  constructor() {
    super();
    this.message = "Подключение изменилось во время запроса. Обновите состояние панели.";
  }
}
/** A lost session is not proof that the video was never published. */
export class UploadSessionExpired extends Error {
  constructor() {
    super("Сессия загрузки YouTube истекла. Проверьте отсутствие поста перед новой загрузкой.");
  }
}
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
  maintain?(platform: Exclude<Platform, "tiktok">): Promise<void>;
  notBefore?(platform: Platform): number;
  canRecover?(delivery: Delivery): boolean;
  publish(video: Video, delivery: Delivery): Promise<void>;
  verifyYoutube(delivery: Delivery): Promise<void>;
}
export type Clock = () => number;
