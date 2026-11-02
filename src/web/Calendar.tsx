import { ChevronLeft, ChevronRight, Pin } from "lucide-react";
import { useMemo } from "react";
import type { Snapshot } from "../shared/model.ts";
import { DAY, HOUR, dayStart, MOSCOW } from "../shared/scheduler.ts";
import { date, time, names } from "./format.ts";
type Item = Snapshot["videos"][number];
export type View = "day" | "week" | "month";
export function Platforms({ video }: { video: Item }) {
  return (
    <div className="platforms">
      {(["youtube", "tiktok", "instagram"] as const).map((p) => {
        const d = video.deliveries.find((d) => d.platform === p);
        return (
          <span
            key={p}
            className={"platform " + p + " " + (d?.state ?? "pending")}
            title={`${names[p]}: ${d?.state === "published" ? "опубликовано" : (d?.error ?? "по расписанию")}`}
            aria-label={`${names[p]} ${d?.state ?? "ожидает"}`}
          >
            {p === "youtube" ? "YT" : p === "instagram" ? "IG" : "TT"}
          </span>
        );
      })}
    </div>
  );
}
export function Calendar({
  videos,
  view,
  setView,
  anchor,
  setAnchor,
  onSelect,
}: {
  videos: Item[];
  view: View;
  setView: (v: View) => void;
  anchor: number;
  setAnchor: (v: number) => void;
  onSelect: (v: Item) => void;
}) {
  const today = dayStart(Date.now());
  const days = useMemo(() => {
    const base = dayStart(anchor),
      weekday = (new Date(base + MOSCOW).getUTCDay() + 6) % 7;
    if (view === "day") return [base];
    if (view === "week")
      return Array.from({ length: 7 }, (_, i) => base + (i - weekday) * DAY);
    const m = new Date(base + MOSCOW);
    const first = Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), 1) - MOSCOW;
    const offset = (new Date(first + MOSCOW).getUTCDay() + 6) % 7;
    return Array.from({ length: 42 }, (_, i) => first + (i - offset) * DAY);
  }, [view, anchor]);
  const events = videos.flatMap((video) => [
    ...(video.scheduledAt === null ? [] : [{ video, at: video.scheduledAt, platform: null }]),
    ...video.deliveries
      .filter((delivery) =>
        ["pending", "failed", "blocked"].includes(delivery.state) &&
        delivery.nextAt >= delivery.originalAt + HOUR,
      )
      .map((delivery) => ({ video, at: delivery.nextAt, platform: delivery.platform })),
  ]);
  const hours = Array.from(
    new Set([
      "06:00",
      "12:00",
      "17:00",
      ...events
        .filter((event) => days.includes(dayStart(event.at)))
        .map((event) => time(event.at)),
    ]),
  ).sort();
  function move(direction: number) {
    if (view === "month") {
      const d = new Date(anchor + MOSCOW);
      setAnchor(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + direction, 1) - MOSCOW,
      );
    } else setAnchor(anchor + direction * (view === "week" ? 7 : 1) * DAY);
  }
  return (
    <>
      <div className="calendar-toolbar">
        <div className="segmented">
          {(["day", "week", "month"] as const).map((v, i) => (
            <button
              key={v}
              className={view === v ? "selected" : ""}
              onClick={() => setView(v)}
            >
              {["День", "Неделя", "Месяц"][i]}
            </button>
          ))}
        </div>
        <div className="date-navigation">
          <button
            className="icon"
            onClick={() => move(-1)}
            aria-label="Предыдущий период"
          >
            <ChevronLeft size={18} />
          </button>
          <strong>
            {view === "month"
              ? date(anchor, { month: "long", year: "numeric" })
              : view === "day"
                ? date(anchor)
                : `${date(days[0], { day: "numeric" })} — ${date(days[6])}`}
          </strong>
          <button
            className="icon"
            onClick={() => move(1)}
            aria-label="Следующий период"
          >
            <ChevronRight size={18} />
          </button>
        </div>
        <button onClick={() => setAnchor(today)}>Сегодня</button>
        <span className="timezone">Москва · GMT+3</span>
      </div>
      {view === "month" ? (
        <div className="month-calendar">
          {["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((d) => (
            <div className="month-weekday" key={d}>
              {d}
            </div>
          ))}
          {days.map((day) => (
            <section
              className={"month-day " + (day === today ? "today" : "")}
              key={day}
            >
              <button
                className="day-number"
                onClick={() => {
                  setAnchor(day);
                  setView("day");
                }}
              >
                {date(day, { day: "numeric" })}
              </button>
              {events
                .filter((event) => dayStart(event.at) === day)
                .sort((a, b) => a.at - b.at)
                .map(({ video: v, at, platform }) => (
                  <button
                    className="month-event"
                    key={`${v.id}:${platform ?? "plan"}`}
                    aria-label={platform ? `Догоняющая публикация ${names[platform]} · ${v.title}` : undefined}
                    onClick={() => onSelect(v)}
                  >
                    <time>{time(at)}</time> {platform ? `${names[platform]} · ` : ""}{v.title}
                  </button>
                ))}
            </section>
          ))}
        </div>
      ) : (
        <div className="calendar-scroll">
          <div
            className={"week-calendar " + (view === "day" ? "single-day" : "")}
          >
            <div className="corner" />
            {days.map((day) => (
              <div
                className={"day-heading " + (day === today ? "today" : "")}
                key={day}
              >
                <strong>{date(day, { day: "numeric" })}</strong>
                <span>{date(day, { weekday: "long" })}</span>
              </div>
            ))}
            {hours.map((hour) => (
              <div className="calendar-row" key={hour}>
                <time className="hour-label">{hour}</time>
                {days.map((day) => (
                  <div
                    className={"calendar-cell " + (day < today ? "past" : "")}
                    key={day}
                  >
                    {events
                      .filter(
                        (event) =>
                          dayStart(event.at) === day &&
                          time(event.at) === hour,
                      )
                      .map(({ video: v, platform }) => (
                        <button
                          aria-label={platform ? `Догоняющая публикация ${names[platform]} · ${v.title}` : undefined}
                          className={
                            "calendar-event " +
                            (v.pinned ? "pinned " : "") +
                            (v.kind === "extra" ? "extra" : "")
                          }
                          key={`${v.id}:${platform ?? "plan"}`}
                          onClick={() => onSelect(v)}
                        >
                          <div className="event-time">
                            {hour}
                            {v.pinned ? <Pin size={12} /> : null}
                          </div>
                          <strong>{v.title}</strong>
                          {platform ? <span>Догоняющая · {names[platform]}</span> : <Platforms video={v} />}
                        </button>
                      ))}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
      {!events.length ? (
        <div className="empty-caption">
          Календарь пока свободен. Загрузите первое видео — найдём ближайший
          слот.
        </div>
      ) : null}
    </>
  );
}
