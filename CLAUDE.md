# CLAUDE.md — FlowScout

Project context for Claude. Agents read this at runtime instead of hardcoding project facts in their prompts.

## Product

FlowScout is an **agent-driven mobile-app exploration & test-generation platform**. Given only an app name + a
build, autonomous agents drive a **simulator via Mobile MCP** to explore _any_ mobile app top-to-bottom, discover
every option (visible and hidden), infer what the app is for, and **map all end-to-end workflows** (including
hidden/duplicate paths) into a grouped, browsable **HTML report**. Later it derives the **test plans that should
exist** and **authors + runs human-like automation tests** that act as **release gates**. Users are internal
**developers and testers** on teams short on coverage, product knowledge, or QA resources. Real data, not mocks;
it asks for credentials when needed and reuses them. Full brief: `docs/sdlc/vision.md`.

## Status & scope

- **Greenfield.** No code yet.
- **MVP = Understand & Document (iOS):** autonomous crawl + workflow map + grouped HTML docs, driven from a web
  dashboard; user supplies a simulator `.app` build; encrypted credential vault with pause-and-ask on 2FA;
  real-data, fully-autonomous exploration. **V1:** test-plan generation. **V2:** automated tests + release gates.
- **FlowScout's own surface:** a **web dashboard** (HTML report is a first-class view). **Target platform: iOS first.**
- **App stack: undecided** — the architect proposes it (ADR). It must support agent orchestration, **Mobile MCP**,
  iOS-simulator control, and HTML reporting. Mobile MCP server: architect selects the best-maintained existing one.
- **Exploration safety:** no in-flow guardrails (owner decision); rely on dedicated test accounts, sandbox envs,
  and disposable/snapshotted simulator state. Never use production endpoints/data.

## How this project is built — the Autonomous SDLC

FlowScout is developed by a **coordinator-led, fully-autonomous** agent loop. The coordinator owns the loop end
to end (including merges and ship); gate failures route back to the developer, not to a human.

Pipeline: **Analyst → Product → Planner → Architect → Designer → Security → Developer → Code-review gate →
Post-impl Architecture review gate → Security gate → QA + E2E gate → Release gate → ship.**

- **Backbone:** GitHub Issues/Projects (single source of truth for work + status).
- **Handoffs:** each agent emits a structured artifact the next consumes.
- Full details: `.claude/AGENT_SYSTEM.md` (governance) — _defined in Item 1._

## Engineering conventions (the architect enforces; refined per chosen stack)

- SOLID, DI, clear layering, abstraction & encapsulation; design patterns applied by name where they fit.
- Favor extensibility; world-class scalable architecture; no code smells.
- MVVM for UI surfaces; layered/hexagonal for backends.
- Test coverage is a gate, not an afterthought; security (OWASP, no leaks) is designed in.
- **Never** commit secrets, real identifiers, or personal absolute paths (see `.gitignore`).

## Pointers

- Agent system governance: `.claude/AGENT_SYSTEM.md`
- Roadmap / status / decisions: `docs/sdlc/roadmap.md`, `STATUS.md`, `docs/sdlc/HANDOFF.md`
