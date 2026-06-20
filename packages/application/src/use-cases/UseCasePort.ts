/**
 * Placeholder use-case interface.
 * Concrete use-cases (StartCrawlRun, GetRunStatus, etc.) will implement this
 * in E1–E5 epic tickets.
 */

/** Base marker interface for all use-cases in the application layer. */
export interface UseCase<TInput, TOutput> {
  execute(input: TInput): Promise<TOutput>;
}
