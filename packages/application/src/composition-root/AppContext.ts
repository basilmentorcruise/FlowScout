/**
 * AppContext — the composition-root type for the application layer.
 * Holds resolved port instances that are injected by the api (or CLI) composition root.
 * No concrete adapters are imported here — the application layer depends only on ports.
 *
 * TODO (E1+): populate with concrete use-case instances as epics land.
 */
import type {
  MobileDriverPort,
  SimulatorLifecycle,
  DecisionPolicy,
  RunRepository,
  StateGraphRepository,
  ReportRepository,
  CredentialVaultPort,
  ReportRendererPort,
  CrawlEventStream,
} from "@flowscout/domain";

/**
 * The set of ports required by the application layer.
 * Wired at the composition root in `packages/api`.
 */
export interface AppPorts {
  readonly mobileDriver: MobileDriverPort;
  readonly simulatorLifecycle: SimulatorLifecycle;
  readonly decisionPolicy: DecisionPolicy;
  readonly runRepository: RunRepository;
  readonly stateGraphRepository: StateGraphRepository;
  readonly reportRepository: ReportRepository;
  readonly credentialVault: CredentialVaultPort;
  readonly reportRenderer: ReportRendererPort;
  readonly crawlEventStream: CrawlEventStream;
}

/**
 * AppContext — placeholder. Will expand as use-cases are implemented in E1+.
 */
export class AppContext {
  constructor(private readonly ports: AppPorts) {}

  getPorts(): AppPorts {
    return this.ports;
  }
}
