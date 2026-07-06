/**
 * PersistenceAdapters — throwing stubs for the three repository ports.
 *
 * @deprecated Superseded by the durable SQLite implementations in `./sqlite/` (ADR-0008,
 * which amends ADR-0001 §2.7 — Postgres/Prisma is deferred behind the same ports).
 * These stubs remain ONLY because the composition root (`packages/api/src/composition-root/wire.ts`)
 * still constructs them; #84 (E7.2) owns the wire.ts swap to the Sqlite* repositories and
 * removes these classes.
 */
import type {
  RunRepository,
  StateGraphRepository,
  ReportRepository,
  Run,
  StateGraph,
  StateNode,
  StateEdge,
  StateIdentity,
  Report,
  ListRunsOptions,
  RunPage,
} from "@flowscout/domain";

function notImplemented(method: string): Promise<never> {
  return Promise.reject(
    new Error(
      `Persistence adapter ${method} is not yet implemented — see TODO (E4/E5) in PersistenceAdapters.ts`,
    ),
  );
}

export class PrismaRunRepository implements RunRepository {
  // TODO (E4): inject PrismaClient
  save(_run: Run): Promise<void> {
    return notImplemented("PrismaRunRepository.save");
  }
  findById(_id: string): Promise<Run | null> {
    return notImplemented("PrismaRunRepository.findById");
  }
  findByAppId(_appId: string, _limit?: number): Promise<readonly Run[]> {
    return notImplemented("PrismaRunRepository.findByAppId");
  }
  update(_id: string, _patch: Partial<Pick<Run, "status" | "finishedAt">>): Promise<void> {
    return notImplemented("PrismaRunRepository.update");
  }
  listRuns(_options: ListRunsOptions): Promise<RunPage> {
    return notImplemented("PrismaRunRepository.listRuns");
  }
}

export class PrismaStateGraphRepository implements StateGraphRepository {
  saveGraph(_graph: StateGraph): Promise<void> {
    return notImplemented("PrismaStateGraphRepository.saveGraph");
  }
  upsertNode(_runId: string, _node: StateNode): Promise<void> {
    return notImplemented("PrismaStateGraphRepository.upsertNode");
  }
  appendEdge(_runId: string, _edge: StateEdge): Promise<void> {
    return notImplemented("PrismaStateGraphRepository.appendEdge");
  }
  findByRunId(_runId: string): Promise<StateGraph | null> {
    return notImplemented("PrismaStateGraphRepository.findByRunId");
  }
  findStatesByApp(_appId: string): Promise<ReadonlyMap<StateIdentity, readonly string[]>> {
    return notImplemented("PrismaStateGraphRepository.findStatesByApp");
  }
}

export class PrismaReportRepository implements ReportRepository {
  save(_report: Report): Promise<void> {
    return notImplemented("PrismaReportRepository.save");
  }
  findById(_reportId: string): Promise<Report | null> {
    return notImplemented("PrismaReportRepository.findById");
  }
  findByRunId(_runId: string): Promise<Report | null> {
    return notImplemented("PrismaReportRepository.findByRunId");
  }
  findByAppId(_appId: string, _limit?: number): Promise<readonly Report[]> {
    return notImplemented("PrismaReportRepository.findByAppId");
  }
}
