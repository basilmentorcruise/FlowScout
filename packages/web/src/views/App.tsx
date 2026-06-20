/**
 * App — root view component (MVVM: passive view).
 * Renders VM state; emits intents back to the VM.
 * No business logic in this component.
 */
import React from "react";
import { useAppViewModel } from "../view-models/AppViewModel.js";
import { ApiClient } from "../model/ApiClient.js";

const apiClient = new ApiClient();

export function App(): React.ReactElement {
  const { state, checkHealth } = useAppViewModel(apiClient);

  return (
    <div>
      <h1>FlowScout</h1>
      <p>Agent-driven mobile app exploration</p>
      {state.isHealthy === null && <p>Checking API health...</p>}
      {state.isHealthy === true && (
        <p>API is healthy (as of {state.healthTimestamp ?? "unknown"})</p>
      )}
      {state.isHealthy === false && <p>API unavailable: {state.error ?? "unknown error"}</p>}
      <button type="button" onClick={() => void checkHealth()}>
        Refresh
      </button>
    </div>
  );
}
