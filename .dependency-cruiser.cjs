/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    /**
     * Hexagonal architecture rule: no inward dependency on adapters.
     * domain and application must NOT import from adapters/*.
     */
    {
      name: "no-inward-adapter-dep",
      severity: "error",
      comment:
        "domain and application must not depend on any adapter. Dependency Inversion: adapters implement ports, not the other way around.",
      from: {
        path: "^packages/(domain|application)/",
      },
      to: {
        path: "^packages/adapters/",
      },
    },
    /**
     * domain must not depend on anything within this monorepo (it's the innermost layer).
     */
    {
      name: "domain-depends-on-nothing",
      severity: "error",
      comment: "domain is the innermost layer — it may not import from any other package.",
      from: {
        path: "^packages/domain/",
      },
      to: {
        path: "^packages/(application|adapters|api|web)/",
      },
    },
    /**
     * application must not depend on adapters, api, or web.
     */
    {
      name: "application-depends-only-on-domain",
      severity: "error",
      comment: "application may only depend on domain (ports), never on adapters, api, or web.",
      from: {
        path: "^packages/application/",
      },
      to: {
        path: "^packages/(adapters|api|web)/",
      },
    },
    /**
     * web must not import from adapters or application internals (only domain types + api contract).
     */
    {
      name: "web-no-direct-adapter-or-application-import",
      severity: "error",
      comment: "web may only import domain types and the api HTTP contract — not adapters or application internals.",
      from: {
        path: "^packages/web/",
      },
      to: {
        path: "^packages/(adapters|application)/",
      },
    },
    /**
     * Circular dependency rule — zero cycles.
     */
    {
      name: "no-circular",
      severity: "error",
      comment: "Circular dependencies are forbidden (smell guard).",
      from: {},
      to: {
        circular: true,
      },
    },
    /**
     * adapters must not import from other adapters (each adapter is independent).
     */
    {
      name: "no-cross-adapter-dep",
      severity: "warn",
      comment: "Adapters should not depend on other adapters — compose at the composition root.",
      from: {
        path: "^packages/adapters/([^/]+)/",
      },
      to: {
        path: "^packages/adapters/",
        pathNot: "^packages/adapters/$1/",
      },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    moduleSystems: ["es6", "cjs"],
    tsConfig: {
      fileName: "tsconfig.base.json",
    },
    reporterOptions: {
      text: {
        highlightFocused: true,
      },
    },
  },
};
