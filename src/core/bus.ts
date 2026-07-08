import type { HubEvent } from '../types.js';

export class HubBus {
  private listeners = new Set<(e: HubEvent) => void>();

  emit(e: HubEvent): void {
    for (const listener of this.listeners) {
      listener(e);
    }
  }

  on(l: (e: HubEvent) => void): () => void {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }
}
