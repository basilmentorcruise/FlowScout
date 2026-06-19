# CLAUDE.md — FlowScout

Project context for Claude. Agents read this at runtime instead of hardcoding project facts in their prompts.

## Product
_(TODO — seed: 2–3 sentences on what FlowScout is, the problem it solves, and who it's for._
_The Analyst agent expands this into an opportunity backlog + MVP/V1/V2 roadmap.)_

## Status & stack
- **Greenfield.** No code yet.
- **Stack: undecided by design.** The Architect agent proposes the surface (web/mobile/backend) and stack as
  part of defining the MVP, recorded here once chosen. Until then, agents must not assume a stack.

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
- Build plan / decisions: `../agent_analysis/FLOWSCOUT_PLAN.md`
