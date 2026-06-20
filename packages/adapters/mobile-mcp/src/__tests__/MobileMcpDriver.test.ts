/**
 * MobileMcpDriver stub tests.
 * Verifies that all methods reject with "not yet implemented" until E1 lands.
 */
import { describe, it, expect } from "vitest";
import { MobileMcpDriver } from "../MobileMcpDriver.js";

describe("MobileMcpDriver (stub)", () => {
  const driver = new MobileMcpDriver();
  const udid = "fake-udid";

  it("listDevices rejects with not-implemented error", async () => {
    await expect(driver.listDevices()).rejects.toThrow("not yet implemented");
  });

  it("snapshotAccessibilityTree rejects with not-implemented error", async () => {
    await expect(driver.snapshotAccessibilityTree(udid)).rejects.toThrow("not yet implemented");
  });

  it("screenshot rejects with not-implemented error", async () => {
    await expect(driver.screenshot(udid)).rejects.toThrow("not yet implemented");
  });

  it("tap rejects with not-implemented error", async () => {
    await expect(driver.tap(udid, { kind: "element", elementId: "btn-1" })).rejects.toThrow(
      "not yet implemented",
    );
  });

  it("typeText rejects with not-implemented error", async () => {
    await expect(driver.typeText(udid, "hello")).rejects.toThrow("not yet implemented");
  });

  it("swipe rejects with not-implemented error", async () => {
    await expect(driver.swipe(udid, "up")).rejects.toThrow("not yet implemented");
  });

  it("bootSimulator rejects with not-implemented error", async () => {
    await expect(driver.bootSimulator(udid)).rejects.toThrow("not yet implemented");
  });

  it("installApp rejects with not-implemented error", async () => {
    await expect(driver.installApp(udid, "/path/app.app")).rejects.toThrow("not yet implemented");
  });

  it("launchApp rejects with not-implemented error", async () => {
    await expect(driver.launchApp(udid, "com.example.app")).rejects.toThrow("not yet implemented");
  });

  it("takeSnapshot rejects with not-implemented error", async () => {
    await expect(driver.takeSnapshot(udid, "clean")).rejects.toThrow("not yet implemented");
  });

  it("resetToSnapshot rejects with not-implemented error", async () => {
    await expect(driver.resetToSnapshot(udid, "clean")).rejects.toThrow("not yet implemented");
  });

  it("shutdownSimulator rejects with not-implemented error", async () => {
    await expect(driver.shutdownSimulator(udid)).rejects.toThrow("not yet implemented");
  });
});
