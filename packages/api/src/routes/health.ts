/**
 * /health route — liveness probe for the FlowScout API.
 * Returns 200 OK with a simple JSON payload.
 * No business logic here — this is the transport layer.
 */
import type { FastifyPluginAsync } from "fastify";

export const healthRoute: FastifyPluginAsync = (fastify) => {
  fastify.get("/health", (_request, _reply) => {
    return Promise.resolve({
      status: "ok",
      service: "flowscout-api",
      timestamp: new Date().toISOString(),
    });
  });
  return Promise.resolve();
};
