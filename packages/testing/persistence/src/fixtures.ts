/**
 * Fixtures for the persistence port-conformance suite (ADR-0008 §7, e7-plan #83).
 *
 * Deliberate content choices (security ACs, e7 threat model):
 *   - Strings carry HTML-ish markup + quotes: repositories must store them RAW and
 *     inert (byte-equal round-trip, no escaping on write) — M83.8 / T7.
 *   - Strings carry the upstream redaction marker `[REDACTED]`: it must round-trip
 *     unchanged (persistence introduces no new secret sink, never de-redacts) — M83.5 / T1.
 *   - `makeLargeGraph` produces hundreds of nodes each carrying a multi-KB serialized
 *     a11y blob — NFR5 (large graphs round-trip without truncation).
 */
import type {
  Run,
  StateGraph,
  StateNode,
  StateEdge,
  StateIdentity,
  Report,
} from "@flowscout/domain";
import { defaultCrawlBudget, makeStateIdentity, makeConfidenceScore } from "@flowscout/domain";

/** Redaction marker as emitted by the upstream E2 CredentialRedactor (kept in sync by test). */
export const REDACTED_MARKER = "[REDACTED]";

/** Hostile-looking but inert markup — must round-trip byte-equal (store raw, encode at render). */
export const HOSTILE_MARKUP = `<script>alert("xss")</script> & 'quotes' <img src=x onerror=1>`;

/** A classic SQL-injection probe used as a lookup id — must yield null, never an effect. */
export const SQLI_PROBE_ID = "'; DROP TABLE runs;--";

const BASE_TIME = "2026-07-02T10:00:00.000Z";
const APP_ID = "app.fixture.flowscout";
const APP_VERSION = "1.2.3";

/** Factory bundle for Run fixtures consumed by `runRunRepositoryContract`. */
export interface RunFixtures {
  makeRun(overrides?: Partial<Run>): Run;
}

/** Factory bundle for StateGraph fixtures consumed by `runStateGraphRepositoryContract`. */
export interface GraphFixtures {
  makeGraph(overrides?: Partial<StateGraph>): StateGraph;
  makeNode(overrides?: Partial<StateNode>): StateNode;
  makeEdge(overrides?: Partial<StateEdge>): StateEdge;
  /** Graph with `nodeCount` nodes, each carrying a multi-KB a11y blob (NFR5). */
  makeLargeGraph(runId: string, nodeCount: number): StateGraph;
}

/** Factory bundle for Report fixtures consumed by `runReportRepositoryContract`. */
export interface ReportFixtures {
  makeReport(overrides?: Partial<Report>): Report;
}

/** Default Run fixture factory. */
export const defaultRunFixtures: RunFixtures = {
  makeRun(overrides?: Partial<Run>): Run {
    const base: Run = {
      id: "run-fixture-1",
      appId: APP_ID,
      appVersion: APP_VERSION,
      platform: "ios",
      budget: defaultCrawlBudget(),
      status: "running",
      startedAt: BASE_TIME,
      finishedAt: null,
      driverVersion: "driver-1.0.0",
      policyVersion: "policy-1.0.0",
      schemaVersion: "schema-1.0.0",
    };
    return { ...base, ...overrides };
  },
};

/** Serialized a11y snapshot with a redacted secure field (upstream-redacted shape). */
function makeA11ySnapshot(label: string): string {
  return JSON.stringify({
    role: "screen",
    label,
    children: [
      { role: "textField", label: "Email", value: "tester@example.test" },
      { role: "secureTextField", label: "Password", value: REDACTED_MARKER },
      { role: "button", label: `Sign in ${HOSTILE_MARKUP}` },
    ],
  });
}

function fixtureNode(overrides?: Partial<StateNode>): StateNode {
  const base: StateNode = {
    id: makeStateIdentity("state-a"),
    label: `Login screen ${HOSTILE_MARKUP} ${REDACTED_MARKER}`,
    platform: "ios",
    firstSeenAt: BASE_TIME,
    a11ySnapshot: makeA11ySnapshot("Login"),
    screenshotUri: null,
  };
  return { ...base, ...overrides };
}

function fixtureEdge(overrides?: Partial<StateEdge>): StateEdge {
  const base: StateEdge = {
    id: "edge-1",
    fromId: makeStateIdentity("state-a"),
    toId: makeStateIdentity("state-b"),
    actionType: "tap",
    actionPayload: JSON.stringify({ x: 10, y: 20, text: REDACTED_MARKER }),
    observedAt: BASE_TIME,
  };
  return { ...base, ...overrides };
}

function fixtureGraph(overrides?: Partial<StateGraph>): StateGraph {
  const nodeA = fixtureNode();
  const nodeB = fixtureNode({
    id: makeStateIdentity("state-b"),
    label: "Home screen",
    a11ySnapshot: makeA11ySnapshot("Home"),
    screenshotUri: "file:///artifacts/state-b.png",
  });
  const nodeC = fixtureNode({
    id: makeStateIdentity("state-c"),
    label: "Settings",
    a11ySnapshot: makeA11ySnapshot("Settings"),
  });
  const nodes = new Map<StateIdentity, StateNode>([
    [nodeA.id, nodeA],
    [nodeB.id, nodeB],
    [nodeC.id, nodeC],
  ]);
  const base: StateGraph = {
    runId: "run-fixture-1",
    appId: APP_ID,
    appVersion: APP_VERSION,
    platform: "ios",
    nodes,
    edges: [
      fixtureEdge(),
      fixtureEdge({ id: "edge-2", fromId: nodeB.id, toId: nodeC.id, actionType: "swipe" }),
    ],
    duplicatePathNodeIds: new Set<StateIdentity>([nodeC.id]),
  };
  return { ...base, ...overrides };
}

/** Byte size of each large-graph a11y filler blob (NFR5: "serialized a11y snapshot" per node). */
const LARGE_GRAPH_BLOB_BYTES = 2048;
/** Every Nth large-graph node is flagged as a duplicate-path node. */
const LARGE_GRAPH_DUPLICATE_STRIDE = 10;

function makeLargeGraph(runId: string, nodeCount: number): StateGraph {
  const nodes = new Map<StateIdentity, StateNode>();
  const edges: StateEdge[] = [];
  const duplicatePathNodeIds = new Set<StateIdentity>();
  for (let i = 0; i < nodeCount; i += 1) {
    const id = makeStateIdentity(`state-${String(i).padStart(4, "0")}`);
    nodes.set(
      id,
      fixtureNode({
        id,
        label: `Screen ${String(i)} ${REDACTED_MARKER}`,
        a11ySnapshot: JSON.stringify({
          role: "screen",
          label: `Screen ${String(i)}`,
          blob: "x".repeat(LARGE_GRAPH_BLOB_BYTES),
        }),
        screenshotUri: `file:///artifacts/state-${String(i)}.png`,
      }),
    );
    if (i > 0) {
      edges.push(
        fixtureEdge({
          id: `edge-${String(i)}`,
          fromId: makeStateIdentity(`state-${String(i - 1).padStart(4, "0")}`),
          toId: id,
        }),
      );
    }
    if (i % LARGE_GRAPH_DUPLICATE_STRIDE === 0) {
      duplicatePathNodeIds.add(id);
    }
  }
  return {
    runId,
    appId: APP_ID,
    appVersion: APP_VERSION,
    platform: "ios",
    nodes,
    edges,
    duplicatePathNodeIds,
  };
}

/** Default StateGraph fixture factory. */
export const defaultGraphFixtures: GraphFixtures = {
  makeGraph: fixtureGraph,
  makeNode: fixtureNode,
  makeEdge: fixtureEdge,
  makeLargeGraph,
};

/** Default Report fixture factory (workflowMap exercises ALL optional #56/#59 fields). */
export const defaultReportFixtures: ReportFixtures = {
  makeReport(overrides?: Partial<Report>): Report {
    const stateA = makeStateIdentity("state-a");
    const stateB = makeStateIdentity("state-b");
    const base: Report = {
      metadata: {
        reportId: "report-fixture-1",
        runId: "run-fixture-1",
        appId: APP_ID,
        appVersion: APP_VERSION,
        generatedAt: BASE_TIME,
        runStatus: "completed",
        artifactUri: "",
        schemaVersion: "schema-1.0.0",
      },
      workflowMap: {
        runId: "run-fixture-1",
        workflows: [
          {
            id: "workflow-1",
            name: `Sign in ${HOSTILE_MARKUP}`,
            description: `Signs the user in ${REDACTED_MARKER}`,
            steps: [
              { stepIndex: 0, stateId: stateA, edge: fixtureEdge(), description: "Tap sign-in" },
              { stepIndex: 1, stateId: stateB, edge: null, description: "Land on home" },
            ],
            isHiddenPath: false,
            inferenceConfidence: makeConfidenceScore(0.9),
            featureGroup: "Authentication",
          },
        ],
        finalisedAt: BASE_TIME,
        appPurpose: "A fixture app for persistence contract tests",
        appPurposeConfidence: makeConfidenceScore(0.8),
        duplicateGroups: [
          {
            outcomeIdentity: stateB,
            workflowIds: ["workflow-1"],
            canonicalWorkflowId: "workflow-1",
            hiddenWorkflowIds: [],
          },
        ],
      },
      totalStates: 3,
      totalWorkflows: 1,
      duplicatePathCount: 1,
    };
    return { ...base, ...overrides };
  },
};
