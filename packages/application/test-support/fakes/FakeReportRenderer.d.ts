/**
 * FakeReportRenderer — in-memory fake for ReportRendererPort.
 */
import type { ReportRendererPort, Report, RenderOptions, RenderResult } from "@flowscout/domain";
import type { WorkflowMap } from "@flowscout/domain";
import type { StateGraph } from "@flowscout/domain";
export declare class FakeReportRenderer implements ReportRendererPort {
  readonly renders: Array<{
    report: Report;
    workflowMap: WorkflowMap;
    stateGraph: StateGraph;
  }>;
  render(
    report: Report,
    workflowMap: WorkflowMap,
    stateGraph: StateGraph,
    options: RenderOptions,
  ): Promise<RenderResult>;
}
//# sourceMappingURL=FakeReportRenderer.d.ts.map
