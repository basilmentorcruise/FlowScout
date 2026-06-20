/**
 * HtmlReportRenderer — stub implementing ReportRendererPort.
 * Generates a grouped, browsable HTML report artifact from the state-graph and workflow map.
 *
 * TODO (E4): Implement full HTML generation (grouped by workflow, screenshots embedded/linked,
 *            hidden-path indicators, downloadable artifact). Consider a lightweight template engine.
 */
import type { ReportRendererPort, Report, RenderOptions, RenderResult } from "@flowscout/domain";
import type { WorkflowMap } from "@flowscout/domain";
import type { StateGraph } from "@flowscout/domain";

function notImplemented(method: string): Promise<never> {
  return Promise.reject(
    new Error(
      `HtmlReportRenderer.${method} is not yet implemented — see TODO (E4) in HtmlReportRenderer.ts`,
    ),
  );
}

export class HtmlReportRenderer implements ReportRendererPort {
  render(
    _report: Report,
    _workflowMap: WorkflowMap,
    _stateGraph: StateGraph,
    _options: RenderOptions,
  ): Promise<RenderResult> {
    return notImplemented("render");
  }
}
