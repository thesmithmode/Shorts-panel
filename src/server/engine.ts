import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { groupDeliveries } from "../shared/deliveries.ts";
import { PLATFORMS } from "../shared/model.ts";
import { plan, recoveryAt, deletionAt, HOUR } from "../shared/scheduler.ts";
import type {
  QueueRepository,
  PublicationGateway,
  Clock,
} from "./contracts.ts";
import { RetryableBeforeSend } from "./contracts.ts";
export class Engine {
  running = false;
  constructor(
    private store: QueueRepository,
    private providers: PublicationGateway,
    private now: Clock = Date.now,
  ) {
    // An interrupted external request may already have published. Require reconciliation.
    for (const d of store.deliveries())
      if (d.state === "processing") {
        if (!d.externalId) {
          if (providers.canRecover?.(d)) {
            d.state = "pending";
            d.error = "Восстанавливаем прерванную загрузку.";
          } else {
            d.state = "unknown";
            d.error =
              "Сервер перезапущен во время отправки. Проверьте публикацию перед повтором.";
          }
          store.delivery(d);
        }
      }
  }
  replan(now = this.now(), preserveHead = true) {
    const videos = this.store.videos();
    const assignments = plan(videos, now, preserveHead);
    for (const v of videos)
      if (assignments.has(v.id) && assignments.get(v.id) !== v.scheduledAt) {
        v.scheduledAt = assignments.get(v.id)!;
        this.store.video(v);
      }
  }
  claim(now = this.now()) {
    this.store.transaction(() => {
      for (const v of this.store.videos())
        if (
          v.state === "queued" &&
          v.scheduledAt !== null &&
          v.scheduledAt <= now
        ) {
          v.state = "dispatched";
          this.store.video(v);
          for (const platform of PLATFORMS)
            this.store.delivery({
              videoId: v.id,
              platform,
              state: "pending",
              originalAt: v.scheduledAt,
              nextAt: v.scheduledAt,
              successAt: null,
              externalId: null,
              url: null,
              error: null,
              attempts: 0,
            });
        }
    });
  }
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.now();
      this.claim(now);
      this.store.transaction(() => this.replan(now));
      // At most one operation per platform concurrently; one failed platform does not stall others.
      await Promise.all(
        PLATFORMS.map(async (platform) => {
          const all = this.store.deliveries();
          for (const d of all)
            if (
              d.platform === platform &&
              ["pending", "blocked", "failed"].includes(d.state) &&
              now >= d.originalAt + HOUR &&
              d.nextAt <= d.originalAt + HOUR
            ) {
              d.nextAt = recoveryAt(
                d.originalAt,
                now,
                platform,
                this.store.videos(),
                all,
              );
              this.store.delivery(d);
            }
          const due = all
            .filter(
              (d) =>
                d.platform === platform &&
                ["pending", "failed", "blocked", "processing"].includes(
                  d.state,
                ) &&
                d.nextAt <= now,
            )
            .sort((a, b) => {
              const regularA = now < a.originalAt + HOUR ? 0 : 1,
                regularB = now < b.originalAt + HOUR ? 0 : 1;
              return regularA - regularB || a.nextAt - b.nextAt;
            })[0];
          if (!due) return;
          const v = this.store.videos().find((v) => v.id === due.videoId);
          if (!v || v.deletedAt) return;
          if (
            !this.providers.connections().find((c) => c.platform === platform)
              ?.connected
          ) {
            due.state = "blocked";
            due.error =
              platform === "tiktok"
                ? "Нужен доступ Direct Post TikTok"
                : "Подключите аккаунт для публикации";
            due.nextAt =
              now < due.originalAt + HOUR
                ? Math.min(now + 60_000, due.originalAt + HOUR)
                : recoveryAt(
                    due.originalAt,
                    now,
                    platform,
                    this.store.videos(),
                    all,
                  );
            this.store.delivery(due);
            return;
          }
          due.state = "processing";
          due.attempts++;
          this.store.delivery(due);
          try {
            if (platform === "youtube" && due.externalId)
              await this.providers.verifyYoutube(due);
            else await this.providers.publish(v, due);
          } catch (error) {
            if (error instanceof RetryableBeforeSend) {
              due.state = "failed";
              due.error = "Не удалось обновить доступ к площадке. Повторим по расписанию.";
              due.nextAt = now < due.originalAt + HOUR
                ? Math.min(now + 60_000, due.originalAt + HOUR)
                : recoveryAt(due.originalAt, now, platform, this.store.videos(), all);
            } else {
              due.state = "unknown";
              due.error =
                "Не удалось подтвердить результат. Проверьте пост на площадке: слепой повтор может создать дубликат.";
            }
            this.store.delivery(due);
          }
        }),
      );
      const deliveriesByVideo = groupDeliveries(this.store.deliveries());
      for (const v of this.store.videos()) {
        const ds = deliveriesByVideo.get(v.id) ?? [];
        const removeAt = deletionAt(ds);
        if (removeAt !== null) {
          if (v.state !== "published") {
            v.state = "published";
            this.store.video(v);
          }
          if (now >= removeAt && !v.deletedAt) {
            try {
              unlinkSync(join(this.store.dir, "videos", v.filename));
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== "ENOENT") continue;
            }
            v.deletedAt = now;
            this.store.video(v);
          }
        }
      }
    } finally {
      this.running = false;
    }
  }
}
