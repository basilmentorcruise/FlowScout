/**
 * FlowScout API — entry point.
 * Builds the Fastify server, wires DI, registers routes.
 */
import Fastify from "fastify";
import { healthRoute } from "./routes/health.js";
import { buildAppContext } from "./composition-root/wire.js";

const PORT = 3000;
const HOST = "0.0.0.0";

async function start(): Promise<void> {
  const fastify = Fastify({
    logger: true,
  });

  // Wire DI composition root
  // TODO (E1+): inject AppContext into route plugins as they are implemented
  buildAppContext();

  // Routes
  await fastify.register(healthRoute);

  try {
    await fastify.listen({ port: PORT, host: HOST });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

void start();

export { buildAppContext };
