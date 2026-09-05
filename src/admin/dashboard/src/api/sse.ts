// src/api/sse.ts
import { useEffect, useRef } from "react";

export type SSEEvent = {
  type: string;
  data: any;
};

export function useSSE(onEvent: (e: SSEEvent) => void) {
  const cbRef = useRef(onEvent);
  cbRef.current = onEvent;

  useEffect(() => {
    const es = new EventSource("/0x/api/events", { withCredentials: true });

    es.onmessage = (e) => {
      try {
        const parsed = JSON.parse(e.data);
        cbRef.current(parsed);
      } catch {}
    };

    es.onerror = () => {
      // Will auto-reconnect
    };

    return () => es.close();
  }, []);
}