import { uiScenarios } from "./ui-scenarios.ts";
import { chromium, expect } from "@playwright/test";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Store, passwordHash } from "../src/server/store.ts";
import { moscowDate, DAY } from "../src/shared/scheduler.ts";
const dir = mkdtempSync(join(tmpdir(), "shorts-smoke-")),
  password = randomBytes(24).toString("hex");
const origin = "http://127.0.0.1:47924";
let processHandle: ReturnType<typeof spawn> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const store = new Store(dir);
  store.set("password", passwordHash(password));
  store.db.close();
  const fixture = join(dir, "fixture.mp4");
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=0x54417e:s=180x320:d=3.1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      fixture,
    ],
    { timeout: 30_000 },
  );
  processHandle = spawn(
    process.execPath,
    ["--import", "tsx", "src/server/index.ts"],
    {
      cwd: resolve("."),
      env: {
        ...process.env,
        SHORTS_DATA_DIR: dir,
        SHORTS_PUBLIC_ORIGIN: origin,
        PORT: "47924",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let logs = "";
  processHandle.stderr!.on("data", (b) => (logs += b.toString()));
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(origin + "/healthz")).ok) break;
    } catch {}
    if (processHandle.exitCode !== null)
      throw new Error("Server stopped: " + logs);
    await delay(100);
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1504, height: 1045 },
  });
  const page = await context.newPage();
  const coverageParts: unknown[] = [];
  async function collectCoverage() {
    if (process.env.SHORTS_BROWSER_COVERAGE)
      coverageParts.push(
        await page.evaluate(() => (window as any).__coverage__),
      );
  }
  let expectedHttpErrors = false;
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (e) => {
    if (
      !expectedHttpErrors &&
      e.type() === "error" &&
      !e.text().includes("401") &&
      !e.text().includes("403")
    )
      errors.push(e.text());
  });
  expect((await context.request.get(origin + "/api/state")).status()).toBe(401);
  await page.goto(origin);
  await expect(page).toHaveTitle("Shorts Panel");
  await page.getByLabel("Пароль", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Войти в панель" }).click();
  await expect(
    page.getByRole("heading", { name: "Календарь", exact: true }),
  ).toBeVisible();
  expect(
    (
      await context.request.post(origin + "/api/logout", {
        headers: { Origin: origin },
        data: {},
      })
    ).status(),
  ).toBe(403);
  const state = await (await context.request.get(origin + "/api/state")).json();
  expect(
    (
      await context.request.post(origin + "/api/logout", {
        headers: { Origin: "https://evil.invalid", "X-CSRF-Token": state.csrf },
        data: {},
      })
    ).status(),
  ).toBe(403);
  await page
    .getByRole("button", { name: "Загрузить видео", exact: true })
    .click();
  await page.locator("input[type=file]").setInputFiles(fixture);
  await page
    .getByLabel("Название", { exact: true })
    .fill("Поездка в Карелию — короткий влог");
  await page
    .getByLabel("Хэштеги", { exact: true })
    .fill("#путешествия #shorts");
  await page.getByRole("button", { name: "Добавить в очередь" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const titles = [
    "Мой рабочий день",
    "Простой рецепт пасты",
    "Закат в центре Москвы",
    "Как снять красивый кадр",
    "Планы на следующую неделю",
    "Утренняя прогулка",
    "Новый проект",
    "За кадром",
  ];
  for (const title of titles) {
    const response = await context.request.post(origin + "/api/videos", {
      headers: {
        Origin: origin,
        "X-CSRF-Token": state.csrf,
        "Content-Type": "video/mp4",
        "X-Video-Title": encodeURIComponent(title),
      },
      data: readFileSync(fixture),
    });
    expect(response.status(), await response.text()).toBe(201);
  }
  const invalid = await context.request.post(origin + "/api/videos", {
    headers: {
      Origin: origin,
      "X-CSRF-Token": state.csrf,
      "Content-Type": "video/mp4",
      "X-Video-Title": "invalid",
    },
    data: Buffer.from("invalid video"),
  });
  expect(invalid.status()).toBe(400);
  await collectCoverage();
  await page.reload();
  await expect(page.locator(".video-list article")).toHaveCount(9);
  const beforeOrder = await (
    await context.request.get(origin + "/api/state")
  ).json();
  const lastId = beforeOrder.videos.at(-1).id;
  await page
    .getByRole("button", { name: "Выше: За кадром", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (
          await (await context.request.get(origin + "/api/state")).json()
        ).videos.at(-2).id,
    )
    .toBe(lastId);
  const snapshot = await (
    await context.request.get(origin + "/api/state")
  ).json();
  const first = snapshot.videos[0];
  const preview = await context.request.get(
    origin + `/api/videos/${first.id}/file`,
    { headers: { Range: "bytes=0-99" } },
  );
  expect(preview.status()).toBe(206);
  expect(
    (
      await context.request.get(
        origin + `/media/${first.id}?expires=1&signature=wrong`,
      )
    ).status(),
  ).toBe(403);
  await page.locator(".video-open").first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel("Закрепить дату и время").check();
  await page
    .getByLabel("Время по Москве")
    .fill(moscowDate(Date.now() + 2 * DAY) + "T15:30");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Месяц", exact: true }).click();
  await expect(page.locator(".month-day")).toHaveCount(42);
  await page.getByRole("button", { name: "День", exact: true }).click();
  await expect(page.locator(".single-day")).toBeVisible();
  await page.getByRole("button", { name: "Неделя", exact: true }).click();
  await page.getByRole("button", { name: "Следующий период" }).click();
  if (process.env.SHORTS_SCREENSHOT_DIR)
    await page.screenshot({
      path: join(process.env.SHORTS_SCREENSHOT_DIR, "shorts-desktop.png"),
      fullPage: true,
    });
  await page.getByRole("button", { name: "Подключения", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "YouTube", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Публичный Direct Post требует допущенного приложения.", {
      exact: false,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Настроить OAuth", exact: true })
    .first()
    .click();
  await page.getByLabel("Client ID", { exact: true }).fill("test-client");
  await page
    .getByLabel("Client Secret", { exact: true })
    .fill("test-secret-never-return-to-browser");
  await page.getByRole("button", { name: "Сохранить на сервере" }).click();
  const safe = await (await context.request.get(origin + "/api/state")).text();
  expect(safe).not.toContain("test-secret-never-return-to-browser");
  await page.getByRole("button", { name: "Календарь", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  if (process.env.SHORTS_SCREENSHOT_DIR)
    await page.screenshot({
      path: join(process.env.SHORTS_SCREENSHOT_DIR, "shorts-mobile.png"),
      fullPage: true,
    });
  await page
    .getByRole("button", { name: "Загрузить видео", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("button", { name: "Закрыть", exact: true })
    .last()
    .click();
  await page.setViewportSize({ width: 1504, height: 1045 });
  await page.getByRole("button", { name: "Выйти", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Ваша неделя контента" }),
  ).toBeVisible();
  expect((await context.request.get(origin + "/api/state")).status()).toBe(401);
  expect(errors).toEqual([]);
  expectedHttpErrors = true;
  await uiScenarios(page, snapshot, fixture, collectCoverage);
  expect(errors).toEqual([]);
  if (process.env.SHORTS_BROWSER_COVERAGE) {
    await collectCoverage();
    writeFileSync(
      process.env.SHORTS_BROWSER_COVERAGE,
      JSON.stringify(coverageParts),
    );
  }
  console.log(
    "PASS: login, CSRF/Origin, real video upload, 9-video queue, pin, all calendar views, preview ranges, OAuth configuration secrecy, desktop/mobile, logout. No runtime/console errors.",
  );
} finally {
  await browser?.close();
  processHandle?.kill("SIGTERM");
  if (processHandle)
    await new Promise<void>((r) => {
      if (processHandle!.exitCode !== null) return r();
      processHandle!.once("exit", () => r());
      setTimeout(() => {
        processHandle?.kill("SIGKILL");
        r();
      }, 5000).unref();
    });
  rmSync(dir, { recursive: true, force: true });
}
