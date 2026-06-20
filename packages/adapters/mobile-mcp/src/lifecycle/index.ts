/**
 * lifecycle/index.ts — #14 (E1.3) replaces the #12 stub with the real implementation.
 *
 * Exports SimulatorLifecycleManager as the default LifecycleCapability implementation
 * plus the capability-specific error types for typed error handling by callers.
 *
 * `capabilities.ts` (frozen by #12) imports `LifecycleStub` from this path and
 * constructs it with `new LifecycleStub(connection, config, exec)`.  We alias
 * `SimulatorLifecycleManager` as `LifecycleStub` so the frozen wiring continues to
 * work without any edit to capabilities.ts.  The appBundleBaseDir fourth param
 * is optional and defaults to FLOWSCOUT_APP_BUNDLE_DIR / os.tmpdir() when omitted.
 *
 * #14 OWNS THIS FILE.
 * DO NOT edit the facade (MobileMcpDriver.ts), capabilities.ts, or simctl.ts.
 */

export {
  SimulatorLifecycleManager,
  LifecycleInputError,
  InstallFailedError,
  LaunchFailedError,
} from "./SimulatorLifecycleManager.js";

// Alias so the frozen `capabilities.ts` continues to compile:
// import { LifecycleStub } from "../lifecycle/index.js"
// new LifecycleStub(connection, config, exec)  ← calls SimulatorLifecycleManager ctor
export { SimulatorLifecycleManager as LifecycleStub } from "./SimulatorLifecycleManager.js";
