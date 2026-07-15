/**
 * Sample-report fixture generator (#87/#88 review aid).
 *
 * Renders a realistic multi-group WorkflowMap — including a hidden-path workflow
 * (amber badge in TOC + header), a THREE-way DuplicatePathGroup (canonical / hidden /
 * alternate route chips in the indigo convergence callout on every member), a
 * >140-char screen label (CSS clamp + title attribute) and a step with no screenshot
 * (text-only placeholder) — through the REAL public API (HtmlReportRenderer) into a
 * gitignored sample-output/ directory. Screenshots are tiny solid-color PNGs generated
 * at runtime (no binary fixtures, no high-entropy literals committed).
 *
 * Usage (from the repo root):
 *   pnpm --filter @flowscout/adapter-report-html build   # once, for dist/
 *   pnpm --filter @flowscout/adapter-report-html sample
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { makeStateIdentity, makeConfidenceScore } from "@flowscout/domain";
import { HtmlReportRenderer } from "../dist/index.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(packageRoot, "sample-output");
const storeDir = path.join(outputDir, "screenshot-store");

// ---------------------------------------------------------------------------
// Minimal valid PNG built from parts at runtime (solid color, width x height).
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Solid-color RGBA PNG. */
function makePng(width, height, [r, g, b]) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 4)]);
  for (let x = 0; x < width; x += 1) {
    row.set([r, g, b, 255], 1 + x * 4);
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Fixture data — a small shopping app with three feature groups.
// ---------------------------------------------------------------------------
const SCREENS = [
  { id: "state-welcome", label: "Welcome", color: [59, 108, 212] },
  { id: "state-login", label: "Sign in", color: [46, 160, 105] },
  { id: "state-home", label: "Home feed", color: [214, 158, 46] },
  { id: "state-search", label: "Search results", color: [154, 92, 199] },
  {
    id: "state-product",
    // Deliberately >140 chars to exercise the design-spec §4 CSS clamp + title attribute.
    label:
      "Product detail — Waterproof hiking boots with reinforced toe cap, breathable Gore-Tex membrane, " +
      "Vibram outsole, quick-lace eyelets, and a removable dual-density footbed (style #BT-4417, alpine edition)",
    color: [200, 82, 70],
  },
  // No color ⇒ no PNG is generated and screenshotUri stays null (text-only step, spec §4).
  { id: "state-wishlist", label: "Wishlist", color: null },
  { id: "state-cart", label: "Cart", color: [52, 152, 166] },
  { id: "state-checkout", label: "Checkout", color: [120, 120, 128] },
  { id: "state-confirm", label: "Order confirmed", color: [40, 167, 90] },
  { id: "state-profile", label: "Profile", color: [90, 98, 180] },
];

function node(id, label, hasScreenshot) {
  return {
    id: makeStateIdentity(id),
    label,
    platform: "ios",
    firstSeenAt: "2026-07-02T09:00:00.000Z",
    a11ySnapshot: "{}",
    screenshotUri: hasScreenshot ? `shots/${id}.png` : null,
  };
}

let edgeSeq = 0;
function step(stepIndex, stateId, description, action) {
  edgeSeq += 1;
  return {
    stepIndex,
    stateId: makeStateIdentity(stateId),
    edge: action
      ? {
          id: `edge-${String(edgeSeq)}`,
          fromId: makeStateIdentity(stateId),
          toId: makeStateIdentity(action.to),
          actionType: action.type,
          actionPayload: action.payload,
          observedAt: "2026-07-02T09:00:01.000Z",
        }
      : null,
    description,
  };
}

function workflow(id, name, description, featureGroup, steps, isHiddenPath = false) {
  return {
    id,
    name,
    description,
    steps,
    isHiddenPath,
    inferenceConfidence: makeConfidenceScore(0.9),
    featureGroup,
  };
}

const workflows = [
  workflow(
    "wf-sign-in",
    "Sign in with email",
    "Authenticate with an existing account from the welcome screen.",
    "Authentication",
    [
      step(0, "state-welcome", "Open the app and tap Sign in", {
        to: "state-login",
        type: "tap",
        payload: '{"element":"Sign in"}',
      }),
      step(1, "state-login", "Enter credentials and submit", {
        to: "state-home",
        type: "typeText",
        payload: '{"fields":["email","password"]}',
      }),
      step(2, "state-home", "Land on the home feed, signed in", null),
    ],
  ),
  workflow(
    "wf-buy-search",
    "Buy a product via search",
    "The canonical purchase route: search, open the product, add to cart, check out.",
    "Shopping",
    [
      step(0, "state-home", "Tap the search field", {
        to: "state-search",
        type: "tap",
        payload: '{"element":"Search"}',
      }),
      step(1, "state-search", 'Search for "hiking boots" and open the first result', {
        to: "state-product",
        type: "typeText",
        payload: '{"query":"hiking boots"}',
      }),
      step(2, "state-product", "Add the boots to the cart", {
        to: "state-cart",
        type: "tap",
        payload: '{"element":"Add to cart"}',
      }),
      step(3, "state-cart", "Proceed to checkout", {
        to: "state-checkout",
        type: "tap",
        payload: '{"element":"Checkout"}',
      }),
      step(4, "state-checkout", "Confirm payment", {
        to: "state-confirm",
        type: "tap",
        payload: '{"element":"Pay now"}',
      }),
      step(5, "state-confirm", "Order confirmed", null),
    ],
  ),
  workflow(
    "wf-buy-deeplink",
    "Buy a product via home-feed promo tile",
    "A hidden alternate purchase route through the promo tile that converges on the same order-confirmed outcome.",
    "Shopping",
    [
      step(0, "state-home", "Long-press the promo tile (undocumented shortcut)", {
        to: "state-product",
        type: "gesture",
        payload: '{"gesture":"longPress","element":"Promo tile"}',
      }),
      step(1, "state-product", "Add the boots to the cart", {
        to: "state-cart",
        type: "tap",
        payload: '{"element":"Add to cart"}',
      }),
      step(2, "state-cart", "Swipe up to reveal the express-checkout sheet", {
        to: "state-confirm",
        type: "swipe",
        payload: '{"direction":"up"}',
      }),
      step(3, "state-confirm", "Order confirmed via the express path", null),
    ],
    true, // isHiddenPath — renders the amber #88 badge in TOC + header
  ),
  workflow(
    "wf-buy-wishlist",
    "Buy a product from the wishlist",
    "A third converging purchase route via the wishlist — neither the canonical search path nor a hidden path.",
    "Shopping",
    [
      step(0, "state-home", "Open the wishlist (no screenshot was captured here)", {
        to: "state-wishlist",
        type: "tap",
        payload: '{"element":"Wishlist"}',
      }),
      step(1, "state-wishlist", "Open the saved boots from the wishlist", {
        to: "state-product",
        type: "tap",
        payload: '{"element":"Saved: hiking boots"}',
      }),
      step(2, "state-product", "Add the boots to the cart", {
        to: "state-cart",
        type: "tap",
        payload: '{"element":"Add to cart"}',
      }),
      step(3, "state-cart", "Proceed to checkout", {
        to: "state-checkout",
        type: "tap",
        payload: '{"element":"Checkout"}',
      }),
      step(4, "state-checkout", "Confirm payment", {
        to: "state-confirm",
        type: "tap",
        payload: '{"element":"Pay now"}',
      }),
      step(5, "state-confirm", "Order confirmed via the wishlist path", null),
    ],
  ),
  workflow(
    "wf-view-profile",
    "View profile",
    "Open the profile tab from the home feed.",
    "Account",
    [
      step(0, "state-home", "Tap the profile tab", {
        to: "state-profile",
        type: "tap",
        payload: '{"element":"Profile"}',
      }),
      step(1, "state-profile", "Profile screen shown", null),
    ],
  ),
  workflow(
    "wf-browse-feed",
    "Browse the home feed",
    "Scroll the feed; no feature group could be inferred for this workflow.",
    undefined, // exercises the catch-all "Ungrouped" section
    [
      step(0, "state-home", "Scroll the home feed", {
        to: "state-home",
        type: "scroll",
        payload: '{"direction":"down"}',
      }),
      step(1, "state-home", "Feed refreshed", null),
    ],
  ),
];

const workflowMap = {
  runId: "run-sample-001",
  workflows,
  finalisedAt: "2026-07-02T09:30:00.000Z",
  appPurpose:
    "An outdoor-gear shopping app: browse and search products, manage a cart, and place orders.",
  appPurposeConfidence: makeConfidenceScore(0.93),
  // A THREE-way DuplicatePathGroup: canonical (search) / hidden (promo deeplink) /
  // alternate (wishlist) — every #88 route chip appears in the rendered callout.
  duplicateGroups: [
    {
      outcomeIdentity: makeStateIdentity("state-confirm"),
      workflowIds: ["wf-buy-deeplink", "wf-buy-search", "wf-buy-wishlist"],
      canonicalWorkflowId: "wf-buy-search",
      hiddenWorkflowIds: ["wf-buy-deeplink"],
    },
  ],
};

const stateGraph = {
  runId: "run-sample-001",
  appId: "com.example.trailhead",
  appVersion: "2.4.1",
  platform: "ios",
  nodes: new Map(
    SCREENS.map(({ id, label, color }) => [makeStateIdentity(id), node(id, label, color !== null)]),
  ),
  edges: [],
  duplicatePathNodeIds: new Set(),
};

const report = {
  metadata: {
    reportId: "report-sample-001",
    runId: "run-sample-001",
    appId: "com.example.trailhead",
    appVersion: "2.4.1",
    generatedAt: "2026-07-02T09:30:00.000Z",
    runStatus: "completed",
    artifactUri: "",
    schemaVersion: "0.0.1",
  },
  workflowMap,
  totalStates: SCREENS.length,
  totalWorkflows: workflows.length,
  duplicatePathCount: 1,
};

// ---------------------------------------------------------------------------
// Render.
// ---------------------------------------------------------------------------
await rm(outputDir, { recursive: true, force: true });
await mkdir(path.join(storeDir, "shots"), { recursive: true });
await Promise.all(
  SCREENS.filter(({ color }) => color !== null).map(({ id, color }) =>
    writeFile(path.join(storeDir, "shots", `${id}.png`), makePng(96, 192, color)),
  ),
);

const renderer = new HtmlReportRenderer({ screenshotRootDir: storeDir });
const result = await renderer.render(report, workflowMap, stateGraph, {
  outputDir,
  embedScreenshots: true,
});

await rm(storeDir, { recursive: true, force: true });

console.log("Sample report written:");
console.log(`  path:  ${fileURLToPath(result.artifactUri)}`);
console.log(`  uri:   ${result.artifactUri}`);
console.log(`  bytes: ${String(result.sizeBytes)}`);
