import { createApplication } from "./app.ts";
const { app, engine } = createApplication();
const port = Number(process.env.PORT ?? 47921);
const host = process.env.SHORTS_BIND ?? "127.0.0.1";
const server = app.listen(port, host, () =>
  console.log(`Shorts Panel listening on ${host}:${port}`),
);
server.requestTimeout = 20 * 60_000;
const timer = setInterval(
  () => engine.tick().catch(() => console.error("Queue tick failed")),
  15_000,
);
timer.unref();
engine.tick().catch(() => console.error("Initial queue tick failed"));
process.on("SIGTERM", () => {
  clearInterval(timer);
  server.close(() => process.exit(0));
});
