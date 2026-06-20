export class FakeReportRenderer {
  renders = [];
  async render(report, workflowMap, stateGraph, options) {
    this.renders.push({ report, workflowMap, stateGraph });
    return {
      artifactUri: `file://${options.outputDir}/report-${report.metadata.reportId}.html`,
      generatedAt: new Date().toISOString(),
      sizeBytes: 1024,
    };
  }
}
//# sourceMappingURL=FakeReportRenderer.js.map
