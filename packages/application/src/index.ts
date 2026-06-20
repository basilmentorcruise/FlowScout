/**
 * @flowscout/application — public API barrel.
 * Use-cases and composition-root types. Depends only on @flowscout/domain ports.
 */

export type { UseCase } from "./use-cases/UseCasePort.js";
export type { AppPorts } from "./composition-root/AppContext.js";
export { AppContext } from "./composition-root/AppContext.js";
