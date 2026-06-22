/**
 * @flowscout/application — public API barrel.
 * Use-cases and composition-root types. Depends only on @flowscout/domain ports.
 */

export type { UseCase } from "./use-cases/UseCasePort.js";
export type { AppPorts } from "./composition-root/AppContext.js";
export { AppContext } from "./composition-root/AppContext.js";

// E2.1 — Walking-skeleton crawl loop
export { StartCrawlRun } from "./crawl/StartCrawlRun.js";
export type { StartCrawlRunInput } from "./crawl/StartCrawlRun.js";
export { defaultCollaborators } from "./crawl/collaborators.js";
export type { CrawlCollaborators, CollaboratorOptions, StateIdentityFn } from "./crawl/collaborators.js";
export { InMemoryStateGraphRepository } from "./crawl/persistence/InMemoryStateGraphRepository.js";
