import { expect, type Page } from "@playwright/test";
import type { Snapshot } from "../src/shared/model.ts";
import { DAY, moscowDate } from "../src/shared/scheduler.ts";
export async function uiScenarios(
  page: Page,
  original: Snapshot,
  fixture: string,
  collect: () => Promise<void>,
) {
  const snapshot = structuredClone(original);
  const base = structuredClone(snapshot.videos[0]);
  const now = Date.now();
  snapshot.connections = snapshot.connections.map((c) => ({
    ...c,
    configured: true,
    connected: c.platform !== "tiktok",
    account: c.platform === "tiktok" ? null : "Test account",
  }));
  snapshot.videos = [
    {
      ...base,
      id: "queued",
      title: "Редактируемый ролик",
      state: "queued",
      pinned: false,
      scheduledAt: now + DAY,
      deliveries: [],
    },
    {
      ...base,
      id: "sent",
      title: "Ролик с ошибкой",
      state: "dispatched",
      scheduledAt: now,
      deliveries: ["unknown", "failed", "blocked"].map((state, i) => ({
        videoId: "sent",
        platform: (["youtube", "instagram", "tiktok"] as const)[i],
        state: state as any,
        originalAt: now,
        nextAt: now + DAY,
        successAt: null,
        externalId: null,
        url: null,
        error: "Тестовая ошибка",
        attempts: 1,
      })),
    },
    {
      ...base,
      id: "published",
      title: "Опубликованный ролик",
      state: "published",
      deliveries: (["youtube", "instagram", "tiktok"] as const).map(
        (platform) => ({
          videoId: "published",
          platform,
          state: "published" as const,
          originalAt: now,
          nextAt: now,
          successAt: now,
          externalId: "post",
          url: "https://example.invalid/post",
          error: null,
          attempts: 1,
        }),
      ),
    },
    {
      ...base,
      id: "deleted",
      title: "Удалённый исходник",
      state: "published",
      deletedAt: now,
      scheduledAt: null,
      deliveries: [],
    },
  ];
  let failure = "",
    rawError = false,
    anonymous = false,
    loginFails = false,
    uploadMode = "json";
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api", "");
    if (path.endsWith("/file")) return route.fulfill({ status: 404, body: "" });
    if (path === "/login") {
      if (loginFails)
        return route.fulfill({ status: 401, json: { error: "Ошибка входа" } });
      anonymous = false;
      return route.fulfill({ json: { csrf: "test" } });
    }
    if (path === "/state") {
      if (anonymous)
        return route.fulfill({ status: 401, json: { error: "Войдите" } });
      if (failure === "state")
        return route.fulfill({
          status: 503,
          json: { error: "Ошибка состояния" },
        });
      return route.fulfill({ json: snapshot });
    }
    if (path === "/videos" && route.request().method() === "POST") {
      if (uploadMode === "network") return route.abort("failed");
      if (uploadMode === "raw")
        return route.fulfill({ status: 400, body: "bad response" });
      return route.fulfill({ status: 400, json: { error: "Ошибка загрузки" } });
    }
    if (path.includes(failure) && failure)
      return rawError
        ? route.fulfill({ status: 400, body: "not-json" })
        : route.fulfill({ status: 400, json: { error: "Тестовая ошибка" } });
    if (path.endsWith("/connect"))
      return route.fulfill({ json: { url: page.url() } });
    return route.fulfill({ json: { ok: true } });
  });
  async function reload(query = "") {
    await collect();
    await page.goto(new URL(query || "/", page.url()).href);
    await expect(page.locator("h1")).not.toBeEmpty();
  }
  async function close() {
    await page
      .getByRole("button", { name: "Закрыть", exact: true })
      .last()
      .click();
  }
  await reload("/?connection_error=1");
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Скрыть ошибку" }).click();
  await page.getByRole("button", { name: "Видео", exact: true }).click();
  await expect(page.locator(".video-list article")).toHaveCount(4);
  await page
    .getByRole("button", { name: "Ниже: Редактируемый ролик" })
    .isDisabled();
  for (const title of ["Опубликованный ролик", "Удалённый исходник"]) {
    await page.locator(".video-open").filter({ hasText: title }).click();
    if (title === "Удалённый исходник")
      await expect(
        page.getByText("Исходник удалён после завершения срока хранения."),
      ).toBeVisible();
    else
      await expect(
        page.getByRole("link", { name: "Открыть публикацию" }),
      ).toHaveCount(3);
    await close();
  }
  await page
    .locator(".video-open")
    .filter({ hasText: "Ролик с ошибкой" })
    .click();
  page.once("dialog", (d) => d.dismiss());
  await page
    .getByRole("button", { name: "Повторить по правилам очереди" })
    .first()
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  failure = "retry";
  page.once("dialog", (d) => d.accept());
  await page
    .getByRole("button", { name: "Повторить по правилам очереди" })
    .first()
    .click();
  await expect(page.getByRole("alert")).toHaveText("Тестовая ошибка");
  failure = "";
  await page
    .getByRole("button", { name: "Повторить по правилам очереди" })
    .nth(1)
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .locator(".video-open")
    .filter({ hasText: "Редактируемый ролик" })
    .click();
  await page.getByLabel("Название", { exact: true }).fill("Новое название");
  await page.getByLabel("Хэштеги", { exact: true }).fill("#new");
  await page.getByLabel("Закрепить дату и время").check();
  await page
    .getByLabel("Время по Москве")
    .fill(moscowDate(now + 2 * DAY) + "T15:30");
  await page.getByLabel("Тип поста").selectOption("extra");
  failure = "/videos/queued";
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Тестовая ошибка");
  failure = "";
  await page.getByLabel("Закрепить дату и время").uncheck();
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Подключения", exact: true }).click();
  failure = "disconnect";
  page.once("dialog", (d) => d.dismiss());
  await page.getByRole("button", { name: "Отключить аккаунт" }).first().click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Отключить аккаунт" }).first().click();
  await expect(page.getByRole("alert")).toHaveText("Тестовая ошибка");
  failure = "";
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Отключить аккаунт" }).first().click();
  const config = page.getByRole("button", { name: "Изменить OAuth" }).first();
  await config.click();
  await config.click();
  await config.click();
  await page.getByLabel("Client ID", { exact: true }).fill("test");
  await page.getByLabel("Client Secret", { exact: true }).fill("test");
  failure = "config";
  await page.getByRole("button", { name: "Сохранить на сервере" }).click();
  await expect(page.getByRole("alert")).toHaveText("Тестовая ошибка");
  failure = "";
  await page.getByRole("button", { name: "Сохранить на сервере" }).click();
  snapshot.connections[0].connected = false;
  await reload();
  await page.getByRole("button", { name: "Подключения", exact: true }).click();
  failure = "connect";
  await page
    .getByRole("button", { name: "Подключить аккаунт" })
    .first()
    .click();
  await expect(page.getByRole("alert")).toHaveText("Тестовая ошибка");
  failure = "";
  await collect();
  await page
    .getByRole("button", { name: "Подключить аккаунт" })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "Календарь", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Месяц", exact: true }).click();
  await page.getByRole("button", { name: "Предыдущий период" }).click();
  await page.getByRole("button", { name: "Следующий период" }).click();
  await page.locator(".day-number").first().click();
  await expect(page.locator(".single-day")).toBeVisible();
  await page.getByRole("button", { name: "Сегодня", exact: true }).click();
  await page.getByRole("button", { name: "Неделя", exact: true }).click();
  const event = page.locator(".calendar-event").first();
  if (await event.count()) {
    await event.click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  for (const mode of ["json", "raw", "network"]) {
    uploadMode = mode;
    await page
      .getByRole("button", { name: "Загрузить видео", exact: true })
      .click();
    await page.locator("input[type=file]").setInputFiles(fixture);
    await page.getByRole("button", { name: "Добавить в очередь" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await close();
  }
  // Login failures and transient state errors must be visible and recoverable.
  anonymous = true;
  await reload();
  await expect(
    page.getByRole("heading", { name: "Ваша неделя контента" }),
  ).toBeVisible();
  loginFails = true;
  await page.getByLabel("Пароль", { exact: true }).fill("wrong");
  await page.getByRole("button", { name: "Войти в панель" }).click();
  await expect(page.getByRole("alert")).toHaveText("Ошибка входа");
  loginFails = false;
  await page.getByRole("button", { name: "Войти в панель" }).click();
  await expect(
    page.getByRole("heading", { name: "Календарь", exact: true }),
  ).toBeVisible();
  failure = "state";
  await reload();
  await expect(page.getByRole("alert")).toHaveText("Ошибка состояния");
  expect((await page.locator(".loading section").boundingBox())!.x).toBeGreaterThanOrEqual(16);
  failure = "";
  await page.getByRole("button", { name: "Повторить загрузку" }).click();
  await expect(
    page.getByRole("heading", { name: "Календарь", exact: true }),
  ).toBeVisible();
  // Reorder error uses an actionable banner; no optimistic silent loss.
  snapshot.videos.push({
    ...snapshot.videos[0],
    id: "queued2",
    position: 99,
    title: "Второй в очереди",
  });
  await reload();
  failure = "reorder";
  rawError = true;
  await page.getByRole("button", { name: "Ниже: Редактируемый ролик" }).click();
  await expect(page.getByRole("alert")).toContainText("Сервер недоступен");
  failure = "";
  rawError = false;
  await page.getByRole("button", { name: "Ниже: Редактируемый ролик" }).click();
  await page.unroute("**/api/**");
}
