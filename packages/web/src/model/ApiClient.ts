/**
 * Model boundary — typed HTTP client for the FlowScout API.
 * The model layer is the only file in web that talks to the API.
 * Views and view-models never make HTTP calls directly.
 *
 * TODO (E5): Expand with all API endpoints as they are implemented.
 */

export interface HealthResponse {
  readonly status: string;
  readonly service: string;
  readonly timestamp: string;
}

export class ApiClient {
  constructor(private readonly baseUrl: string = "") {}

  async getHealth(): Promise<HealthResponse> {
    const response = await fetch(`${this.baseUrl}/health`);
    if (!response.ok) {
      throw new Error(`Health check failed: ${String(response.status)}`);
    }
    return response.json() as Promise<HealthResponse>;
  }
}
