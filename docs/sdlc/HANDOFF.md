# Coordinator Handoff — ready for autonomous delivery

State as of this handoff (everything below is committed to `main`):

- **Vision** captured: `docs/sdlc/vision.md`; product seed in `CLAUDE.md`.
- **Roadmap** (RICE, MVP/V1/V2): `docs/sdlc/roadmap.md`; **10 epics** on GitHub Project #4 (#1–#10).
- **Architecture** decided: `docs/sdlc/architecture/ADR-0001` (TS/Node, hexagonal, Mobile MCP behind an adapter, Postgres+Prisma, AES-256-GCM vault, Vitest 80% line+branch).
- **Foundation scaffolded & merged** (PR #11): pnpm+Turborepo monorepo (`packages/{domain,application,adapters/*,api,web,config}`), CI green (lint/typecheck/build/test/depcruise/jscpd/format + gitleaks), pre-commit hooks.
- **Agent suite** installed globally (`~/.claude/agents/`); coordinator + `/agent-*` commands in `.claude/`.

## To continue (in a new window)

From the FlowScout repo, run:

```
/coordinator
```

The coordinator will boot, see the ADR + scaffold are already done (idempotent — it won't re-scaffold), then
break down the highest-priority MVP epic (**E1 — Mobile MCP + simulator foundation**, #1) into tickets via the
`product` agent and start the autonomous build→gate→merge loop.

### Environment note

Epics **E1/E2** drive a real iOS Simulator via Mobile MCP, so completing their QA/E2E needs **macOS + Xcode +
iOS Simulator + the mobile-next/Mobile MCP server**. Design, scaffolding, and non-simulator tickets run anywhere;
simulator-dependent steps need that environment.

### Autonomy reminder

Fully autonomous: the coordinator merges and ships on its own (CI-green + all gates). The only stop is the
circuit-breaker (3 gate failures on a ticket → `needs-attention` issue). Branch protection is coordinator-enforced
(platform protection needs a non-free/private plan).
