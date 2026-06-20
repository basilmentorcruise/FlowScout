/**
 * AppViewModel — root view-model (MVVM).
 * Owns application state and orchestration; views are passive (render VM state, emit intents).
 *
 * TODO (E5): Expand with run management, live crawl observation (SSE), credential management VMs.
 */
import { useState, useEffect, useCallback } from "react";
import type { ApiClient, HealthResponse } from "../model/ApiClient.js";

export interface AppState {
  readonly isHealthy: boolean | null; // null = loading
  readonly healthTimestamp: string | null;
  readonly error: string | null;
}

const INITIAL_STATE: AppState = {
  isHealthy: null,
  healthTimestamp: null,
  error: null,
};

/** useAppViewModel — the root view-model hook. Returns state + intent handlers. */
export function useAppViewModel(apiClient: ApiClient): {
  state: AppState;
  checkHealth: () => Promise<void>;
} {
  const [state, setState] = useState<AppState>(INITIAL_STATE);

  const checkHealth = useCallback(async (): Promise<void> => {
    setState((prev) => ({ ...prev, error: null }));
    try {
      const health: HealthResponse = await apiClient.getHealth();
      setState({
        isHealthy: health.status === "ok",
        healthTimestamp: health.timestamp,
        error: null,
      });
    } catch (err) {
      setState({
        isHealthy: false,
        healthTimestamp: null,
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }, [apiClient]);

  useEffect(() => {
    void checkHealth();
  }, [checkHealth]);

  return { state, checkHealth };
}
