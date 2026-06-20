/**
 * AppContext composition-root stub test.
 * Verifies the DI wiring type-checks and exposes ports correctly.
 * Uses FakeMobileDriver from test-support to avoid any I/O.
 */
import { describe, it, expect } from "vitest";
import { AppContext } from "../composition-root/AppContext.js";
import type { AppPorts } from "../composition-root/AppContext.js";
import {
  FakeMobileDriver,
  FakeSimulatorLifecycle,
  FakeDecisionPolicy,
  FakeRunRepository,
  FakeStateGraphRepository,
  FakeReportRepository,
  FakeCredentialVault,
  FakeReportRenderer,
  FakeCrawlEventStream,
} from "../../test-support/fakes/index.js";

function makeFakePorts(): AppPorts {
  return {
    mobileDriver: new FakeMobileDriver(),
    simulatorLifecycle: new FakeSimulatorLifecycle(),
    decisionPolicy: new FakeDecisionPolicy(),
    runRepository: new FakeRunRepository(),
    stateGraphRepository: new FakeStateGraphRepository(),
    reportRepository: new FakeReportRepository(),
    credentialVault: new FakeCredentialVault(),
    reportRenderer: new FakeReportRenderer(),
    crawlEventStream: new FakeCrawlEventStream(),
  };
}

describe("AppContext", () => {
  it("constructs with all ports and exposes them", () => {
    const ports = makeFakePorts();
    const ctx = new AppContext(ports);
    expect(ctx.getPorts()).toBe(ports);
  });

  it("exposes the mobileDriver port", () => {
    const ports = makeFakePorts();
    const ctx = new AppContext(ports);
    expect(ctx.getPorts().mobileDriver).toBeInstanceOf(FakeMobileDriver);
  });

  it("exposes the crawlEventStream port", () => {
    const ports = makeFakePorts();
    const ctx = new AppContext(ports);
    expect(ctx.getPorts().crawlEventStream).toBeInstanceOf(FakeCrawlEventStream);
  });
});
