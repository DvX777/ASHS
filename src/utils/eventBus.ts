// src/utils/eventBus.ts — In-memory SSE event bus
// Download manager, SRR, and scheduler publish here.
// SSE endpoint subscribes and forwards to connected admin clients.

type EventHandler = (type: string, data: any) => void;

class EventBus {
  private handlers: Set<EventHandler> = new Set();

  emit(type: string, data: any): void {
    for (const h of Array.from(this.handlers)) {
      try { h(type, data); } catch {}
    }
  }

  subscribe(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  get subscriberCount(): number {
    return this.handlers.size;
  }
}

export const eventBus = new EventBus();

// Typed emit helpers
export const Events = {
  downloadProgress: (data: { jobId: number; title: string; quality: number; percent: number; speed: number; eta: number }) =>
    eventBus.emit("download:progress", data),
  downloadComplete: (data: { jobId: number; title: string; quality: number; sizeBytes: number }) =>
    eventBus.emit("download:complete", data),
  downloadFailed: (data: { jobId: number; title: string; error: string }) =>
    eventBus.emit("download:failed", data),
  queueStats: (data: { active: number; pending: number; failed: number; done: number }) =>
    eventBus.emit("queue:stats", data),
  systemHealth: (data: any) =>
    eventBus.emit("system:health", data),
  srrStarted: (data: { runId: number; type: string; target?: string }) =>
    eventBus.emit("srr:started", data),
  srrProgress: (data: { runId: number; step: string; found: number; fixed: number; message: string }) =>
    eventBus.emit("srr:progress", data),
  srrComplete: (data: { runId: number; totalFound: number; totalFixed: number; durationMs: number }) =>
    eventBus.emit("srr:complete", data),
  healerAlert: (data: { issueType: string; count: number }) =>
    eventBus.emit("healer:alert", data),
};