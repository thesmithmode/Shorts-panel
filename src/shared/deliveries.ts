import type { Delivery } from './model.ts';
/** Group deliveries once so callers do not repeatedly scan the entire history. */
export function groupDeliveries(deliveries: readonly Delivery[]): Map<string, Delivery[]> {
  const groups = new Map<string, Delivery[]>();
  for (const delivery of deliveries) {
    const group = groups.get(delivery.videoId) ?? [];
    group.push(delivery);
    groups.set(delivery.videoId, group);
  }
  return groups;
}
