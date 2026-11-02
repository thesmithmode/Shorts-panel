import { resolve } from "node:path";
import { createApplication } from "./app.ts";
import { acquireInstanceLock } from "./instance-lock.ts";

const releaseLock = acquireInstanceLock(resolve(process.env.SHORTS_DATA_DIR ?? "data"));
const { app, engine } = createApplication();
const port = Number(process.env.PORT ?? 47921);
const host = process.env.SHORTS_BIND ?? "127.0.0.1";
let timer: ReturnType<typeof setInterval> | undefined;
const server = app.listen(port, host, () => {
  console.log(`Shorts Panel listening on ${host}:${port}`);
  timer = setInterval(
    () => engine.tick().catch(() => console.error("Queue tick failed")),
    15_000,
  );
  timer.unref();
  engine.tick().catch(() => console.error("Initial queue tick failed"));
});
server.requestTimeout = 20 * 60_000;
process.on("SIGTERM", () => {
  if (timer) clearInterval(timer);
  server.close(async () => {
    await engine.whenIdle();
    releaseLock();
    process.exit(0);
  });
});
