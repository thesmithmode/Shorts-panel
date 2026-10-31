import type { DeliveryState } from "../shared/model.ts";
export const time = (n: number) =>
  new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit",
  }).format(n);
export const date = (
  n: number,
  options: Intl.DateTimeFormatOptions = { day: "numeric", month: "long" },
) =>
  new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    ...options,
  }).format(n);
export const bytes = (n: number) =>
  n >= 1024 ** 3
    ? `${(n / 1024 ** 3).toFixed(1)} ГБ`
    : `${(n / 1024 ** 2).toFixed(0)} МБ`;
export const stateLabel: Record<DeliveryState, string> = {
  pending: "Ожидает",
  processing: "Обработка",
  published: "Опубликовано",
  failed: "Ошибка",
  blocked: "Нет подключения",
  unknown: "Проверьте результат",
};
export const names = {
  youtube: "YouTube",
  instagram: "Instagram",
  tiktok: "TikTok",
};
