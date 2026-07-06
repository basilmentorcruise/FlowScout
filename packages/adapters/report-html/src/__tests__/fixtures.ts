/**
 * Shared test fixtures — builders for Report / WorkflowMap / StateGraph.
 */
import type {
  Report,
  StateEdge,
  StateGraph,
  StateNode,
  Workflow,
  WorkflowMap,
  WorkflowStep,
} from "@flowscout/domain";
import { makeStateIdentity } from "@flowscout/domain";

/**
 * Overrides that may set a key to `undefined` to mean "absent" — merged with
 * undefined-valued keys DELETED so the result honours exactOptionalPropertyTypes.
 */
export type Overrides<T> = { readonly [K in keyof T]?: T[K] | undefined };

function mergeDefined<T extends object>(base: T, overrides: Overrides<T>): T {
  const merged = { ...(base as Record<string, unknown>), ...overrides };
  return Object.fromEntries(
    Object.entries(merged).filter(([, value]) => value !== undefined),
  ) as unknown as T;
}

export function makeNode(id: string, overrides: Overrides<StateNode> = {}): StateNode {
  return mergeDefined<StateNode>(
    {
      id: makeStateIdentity(id),
      label: `Screen ${id}`,
      platform: "ios",
      firstSeenAt: "2026-06-20T00:00:00.000Z",
      a11ySnapshot: "{}",
      screenshotUri: null,
    },
    overrides,
  );
}

export function makeEdge(
  from: string,
  to: string,
  overrides: Overrides<StateEdge> = {},
): StateEdge {
  return mergeDefined<StateEdge>(
    {
      id: `edge-${from}-${to}`,
      fromId: makeStateIdentity(from),
      toId: makeStateIdentity(to),
      actionType: "tap",
      actionPayload: '{"x":10,"y":20}',
      observedAt: "2026-06-20T00:00:01.000Z",
    },
    overrides,
  );
}

export function makeStep(
  stepIndex: number,
  stateId: string,
  overrides: Overrides<WorkflowStep> = {},
): WorkflowStep {
  return mergeDefined<WorkflowStep>(
    {
      stepIndex,
      stateId: makeStateIdentity(stateId),
      edge: makeEdge(stateId, `${stateId}-next`),
      description: `Step ${String(stepIndex)} on ${stateId}`,
    },
    overrides,
  );
}

export function makeWorkflow(id: string, overrides: Overrides<Workflow> = {}): Workflow {
  return mergeDefined<Workflow>(
    {
      id,
      name: `Workflow ${id}`,
      description: `Description of ${id}`,
      steps: [
        makeStep(0, "state-a"),
        makeStep(1, "state-b", { edge: null, description: "Terminal" }),
      ],
      isHiddenPath: false,
      inferenceConfidence: null,
      featureGroup: "Authentication",
    },
    overrides,
  );
}

export function makeGraph(
  nodes: readonly StateNode[],
  overrides: Overrides<StateGraph> = {},
): StateGraph {
  return mergeDefined<StateGraph>(
    {
      runId: "run-1",
      appId: "com.example.app",
      appVersion: "1.0.0",
      platform: "ios",
      nodes: new Map(nodes.map((node) => [node.id, node])),
      edges: [],
      duplicatePathNodeIds: new Set(),
    },
    overrides,
  );
}

export function makeMap(
  workflows: readonly Workflow[],
  overrides: Overrides<WorkflowMap> = {},
): WorkflowMap {
  return mergeDefined<WorkflowMap>(
    {
      runId: "run-1",
      workflows,
      finalisedAt: "2026-06-20T00:01:00.000Z",
      appPurpose: "A sample shopping app",
      appPurposeConfidence: null,
    },
    overrides,
  );
}

export function makeReport(workflowMap: WorkflowMap, overrides: Partial<Report> = {}): Report {
  return {
    metadata: {
      reportId: "report-1",
      runId: workflowMap.runId,
      appId: "com.example.app",
      appVersion: "1.0.0",
      generatedAt: "2026-06-20T00:01:00.000Z",
      runStatus: "completed",
      artifactUri: "",
      schemaVersion: "0.0.1",
      ...(overrides.metadata ?? {}),
    },
    workflowMap,
    totalStates: overrides.totalStates ?? 2,
    totalWorkflows: overrides.totalWorkflows ?? workflowMap.workflows.length,
    duplicatePathCount: overrides.duplicatePathCount ?? 0,
  };
}

export const DEFAULT_NODES = [makeNode("state-a"), makeNode("state-b")];
