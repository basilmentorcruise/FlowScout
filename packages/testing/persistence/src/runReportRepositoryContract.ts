/**
 * ReportRepository port-conformance section (ADR-0008 §7).
 *
 * Shared behavior runs for every implementation; the `reopen`-gated durability
 * assertions (NFR1) run only for durable implementations.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { Report, ReportRepository } from "@flowscout/domain";
import type { ReportFixtures } from "./fixtures.js";
import { SQLI_PROBE_ID, REDACTED_MARKER, HOSTILE_MARKUP } from "./fixtures.js";

export interface ReportRepositoryContractOptions {
  /** Returns a FRESH, EMPTY repository. */
  createRepository: () => ReportRepository;
  /** Durable impls only: returns a NEW instance over the SAME underlying storage (NFR1). */
  reopen?: (repository: ReportRepository) => ReportRepository;
  fixtures: ReportFixtures;
}

export function runReportRepositoryContract(options: ReportRepositoryContractOptions): void {
  const { createRepository, reopen, fixtures } = options;

  describe("ReportRepository contract", () => {
    let repository: ReportRepository;

    beforeEach(() => {
      repository = createRepository();
    });

    describe("roundtrip (FR3)", () => {
      it("returns a deep-equal Report by runId and by reportId (incl. full WorkflowMap)", async () => {
        const report = fixtures.makeReport();
        await repository.save(report);
        await expect(repository.findByRunId(report.metadata.runId)).resolves.toEqual(report);
        await expect(repository.findById(report.metadata.reportId)).resolves.toEqual(report);
      });

      it("persists workflow strings RAW and inert — byte-equal round-trip (M83.5/M83.8)", async () => {
        const report = fixtures.makeReport();
        await repository.save(report);
        const reloaded = await repository.findByRunId(report.metadata.runId);
        const savedWorkflow = report.workflowMap.workflows[0];
        const reloadedWorkflow = reloaded?.workflowMap.workflows[0];
        // Strict equality = byte-equal: no escaping/transform was applied on write.
        expect(reloadedWorkflow?.name).toBe(savedWorkflow?.name);
        expect(reloadedWorkflow?.description).toBe(savedWorkflow?.description);
        expect(savedWorkflow?.name).toContain(HOSTILE_MARKUP);
        expect(savedWorkflow?.description).toContain(REDACTED_MARKER);
      });
    });

    describe("upsert by runId (E4 artifactUri seam — ADR-0008 §3)", () => {
      it("re-saving the run's report replaces it (E4 later flips artifactUri via the same save)", async () => {
        const report = fixtures.makeReport();
        await repository.save(report);
        const rendered: Report = {
          ...report,
          metadata: { ...report.metadata, artifactUri: "file:///reports/run-fixture-1.html" },
        };
        await repository.save(rendered);
        await expect(repository.findByRunId(report.metadata.runId)).resolves.toEqual(rendered);
        await expect(repository.findByAppId(report.metadata.appId)).resolves.toHaveLength(1);
      });
    });

    describe("findByAppId", () => {
      it("returns only that app's reports, NEWEST-FIRST by (generatedAt, reportId), and respects limit (#85 pinned ordering)", async () => {
        // Saved OUT of chronological order so insertion order cannot pass by accident.
        const reportOne = fixtures.makeReport({
          metadata: {
            ...fixtures.makeReport().metadata,
            generatedAt: "2026-07-02T10:01:00.000Z",
          },
        });
        const reportTwo = fixtures.makeReport({
          metadata: {
            ...fixtures.makeReport().metadata,
            reportId: "report-fixture-2",
            runId: "run-fixture-2",
            generatedAt: "2026-07-02T10:02:00.000Z",
          },
        });
        const otherApp = fixtures.makeReport({
          metadata: {
            ...fixtures.makeReport().metadata,
            reportId: "report-other",
            runId: "run-other",
            appId: "app.other",
          },
        });
        await repository.save(reportOne);
        await repository.save(otherApp);
        await repository.save(reportTwo);
        const reports = await repository.findByAppId(reportOne.metadata.appId);
        expect(reports.map((r) => r.metadata.reportId)).toEqual([
          "report-fixture-2",
          "report-fixture-1",
        ]);
        await expect(repository.findByAppId(reportOne.metadata.appId, 1)).resolves.toEqual([
          reportTwo,
        ]);
      });

      it("breaks generatedAt ties by reportId descending (deterministic order, #85)", async () => {
        const sameTime = "2026-07-02T10:10:00.000Z";
        const base = fixtures.makeReport().metadata;
        const reportA = fixtures.makeReport({
          metadata: { ...base, reportId: "report-a", runId: "run-a", generatedAt: sameTime },
        });
        const reportB = fixtures.makeReport({
          metadata: { ...base, reportId: "report-b", runId: "run-b", generatedAt: sameTime },
        });
        await repository.save(reportA);
        await repository.save(reportB);
        const reports = await repository.findByAppId(base.appId);
        expect(reports.map((r) => r.metadata.reportId)).toEqual(["report-b", "report-a"]);
      });
    });

    describe("not-found (FR7)", () => {
      it("returns null for unknown reportId / runId, never an error", async () => {
        await expect(repository.findById("no-such-report")).resolves.toBeNull();
        await expect(repository.findByRunId("no-such-run")).resolves.toBeNull();
      });

      it("treats a SQL-injection-shaped id as a plain value (T3)", async () => {
        const report = fixtures.makeReport();
        await repository.save(report);
        await expect(repository.findById(SQLI_PROBE_ID)).resolves.toBeNull();
        await expect(repository.findByRunId(SQLI_PROBE_ID)).resolves.toBeNull();
        await expect(repository.findByRunId(report.metadata.runId)).resolves.toEqual(report);
      });
    });

    if (reopen) {
      describe("durability across a fresh store instance (NFR1)", () => {
        it("returns the saved report, deep-equal, from a reopened repository", async () => {
          const report = fixtures.makeReport();
          await repository.save(report);
          const reopened = reopen(repository);
          await expect(reopened.findByRunId(report.metadata.runId)).resolves.toEqual(report);
        });
      });
    }
  });
}
