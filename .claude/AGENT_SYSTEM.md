# FlowScout Agent System — Governance Standard

Single source of truth for how every FlowScout agent, skill, and gate is structured. Authored against
Anthropic's Skill best-practices. Reusable role personas live globally in `~/.claude/agents/`; FlowScout
context lives in `CLAUDE.md` and on the GitHub Project board. (Intended to be promoted to a global standard later.)

## Contents
- Mental model
- Role roster (model / tools / memory / home)
- Frontmatter standard (agents & skills)
- Memory conventions
- Handoff artifacts & where they live
- Gate protocol & the autonomous loop
- GitHub backbone (labels, columns, naming)
- Authoring rules (skills & descriptions)

---

## Mental model
| Primitive | Job |
|-----------|-----|
| **Agent** | A specialist persona with instructions, tools, and (sometimes) memory. A different *role*. |
| **Skill** (`/agent-*`) | A thin slash-command entry point that dispatches an agent with the right context. |
| **Gate** | An agent invocation whose verdict (`PASS/FAIL/BLOCKED`) controls whether the coordinator advances a ticket. |
| **Artifact** | The structured output one stage hands to the next. |

The **coordinator** is the only long-running agent; it owns the loop and spawns every other agent.

---

## Role roster
Reasoning/gatekeeping roles = `opus`; execution roles = `sonnet`. Least-privilege tools. `memory` only where knowledge accumulates.

| Role | Model | Tools | Memory | Home | One-line job |
|------|-------|-------|--------|------|--------------|
| **coordinator** | opus | Agent, Bash(gh/git), Read, Glob, Grep | yes | project | Runs the autonomous loop; dispatches, gates, merges, ships. |
| **analyst** | opus | Read, Glob, Grep, WebSearch, Bash | yes | global | Gap/feature discovery, prioritization, MVP/V1/V2 roadmap. |
| **product** | opus | Read, Glob, Grep, Bash | yes | global | PRD + breakdown into issues with acceptance criteria. |
| **planner** | opus | Read, Glob, Grep | no | global | Per-ticket scope/brief; surfaces ambiguity before work. |
| **architect** | opus | Read, Glob, Grep, Bash | yes | global | Design-time plan **and** post-impl architecture review gate. |
| **designer** | sonnet | Read, Glob, Grep | no | global | HCI + scalable design-system spec for UI tickets. |
| **security** | opus | Read, Glob, Grep, Bash | yes | global | Threat model + OWASP/leak security gate. |
| **developer** | sonnet | Read, Glob, Grep, Bash, Edit, Write | no | global | Implements one ticket incrementally, with tests. |
| **code-reviewer** | opus | Read, Glob, Grep, Bash | no | global | Code-review gate: smells, coverage, SOLID/pattern adherence. |
| **qa** | sonnet | Read, Glob, Grep, Bash, Edit, Write, **Agent** | yes | global | Unit/integration/coverage + E2E human-sim gate. |
| **release-coordinator** | sonnet | Read, Glob, Grep, Bash | no | global | Final SHIP/HOLD go/no-go across all gates. |

`Agent` tool is granted **only** to coordinator (orchestration) and qa (E2E sub-agent fan-out). `Edit/Write`
only to developer and qa (tests). All gatekeepers are read-only.

---

## Frontmatter standard
**Agents** (`~/.claude/agents/<role>.md` or project `.claude/agents/`):
```yaml
---
name: <role>                 # lowercase-hyphen
description: >               # THIRD PERSON, what + when + 1-2 example triggers (routing rule)
  <what it does>. Use when <trigger conditions>.
model: opus | sonnet
tools: Read, Glob, Grep[, ...]   # least privilege; omit nothing — be explicit
color: <ui color>
memory: project              # ONLY if the role accumulates knowledge
---
## Role / ## Core Responsibilities / ## Operating Rules / ## Required Output Format
```
- Read project facts from `CLAUDE.md` at runtime; **never hardcode** product names, stacks, or absolute paths.
- Don't lecture on universally-known concepts (SOLID, OWASP) — name and apply them.

**Skills** (`.claude/skills/<name>/SKILL.md`): `name` (lowercase-hyphen, no `claude`/`anthropic`),
third-person `description` (what + when, ≤1024 chars, no XML), `user-invocable`, optional `context: fork`,
`agent`, `argument-hint`. Always handle the no-args fallback.

---

## Memory conventions
- Dir: `.claude/agent-memory/<role>/` (**repo-relative** — never an absolute path).
- `MEMORY.md` is the index (≤200 lines, one line per entry). Individual files carry `name/description/type` frontmatter (`feedback|project|user|reference`).
- Declared namespace **must** match the on-disk dir name. Verify stale memories against code before acting.

---

## Handoff artifacts & where they live
Hybrid: **specs in-repo** (versioned, PR-reviewable) · **tracking + gate verdicts on GitHub**.

| Artifact | Producer | Location |
|----------|----------|----------|
| Roadmap (MVP/V1/V2, prioritized) | analyst | `docs/sdlc/roadmap.md` (living) |
| PRD (per epic) | product | `docs/sdlc/prd/PRD-<slug>.md` |
| Ticket brief + acceptance criteria | planner | GitHub **issue body** |
| Architecture plan / ADR | architect | `docs/sdlc/architecture/ADR-<n>-<slug>.md` (+ per-epic plan) |
| Design spec | designer | `docs/sdlc/design/<slug>-spec.md` |
| Threat model | security | `docs/sdlc/security/<slug>-threat-model.md` |
| Implementation report | developer | **PR description** |
| Review / arch-review / security verdicts | reviewer / architect / security | **PR review** (structured comment) |
| QA + E2E report | qa | **issue/PR comment** |
| Ship decision | release-coordinator | **release issue** |

Every artifact ends with a fenced **`## Required Output Format`** block defined in the producing agent.

---

## Gate protocol & the autonomous loop
**Pipeline (per ticket):**
```
Analyst → Product → Planner → Architect(plan) → Designer* → Security(threat model)
  → Developer → [Code-review gate] → [Architecture-review gate] → [Security gate]
  → [QA + E2E gate] → [Release gate] → coordinator merges & ships
        (* Designer only for UI tickets)
```
**Gate verdict schema** (every gate returns this):
```
gate: <name> · ticket: #<n>
verdict: PASS | FAIL | BLOCKED
reasons: [...]      # required unless PASS
evidence: [...]     # file:line, command output, artifact links
```
**Coordinator routing:**
- `PASS` → advance to next stage.
- `FAIL` → route back to **developer** with `reasons`; increment the ticket's attempt counter.
- `BLOCKED` → open a `needs-attention` issue with full history.

**Circuit-breaker (autonomous-safe):** when the **same gate** fails a ticket **3 times**, stop retrying —
open a `needs-attention` issue containing the gate history + last verdict, label the ticket `blocked`, and
move the loop to other eligible work. No human approval gates otherwise; this is the only stop.

---

## GitHub backbone
- **Project board columns:** `Backlog → Specced → In Progress → In Review → QA → Done` (+ `Blocked`).
- **Issue types (labels):** `type:epic`, `type:feature`, `type:task`, `type:bug`.
- **Gate labels:** `gate:code-review`, `gate:arch`, `gate:security`, `gate:qa` (current stage).
- **Tier labels:** `mvp`, `v1`, `v2` (set by analyst).
- **State labels:** `blocked`, `needs-attention`.
- **Branch/PR:** branch `fs-<issue>-<slug>` off `main` (protected); PR `Closes #<issue>`; one ticket → one branch → one PR.

---

## Authoring rules (skills & descriptions)
- Descriptions: third person, state **what + when**, ≤1024 chars, no XML.
- SKILL.md body < 500 lines; files > 100 lines get a table of contents; references one level deep.
- No time-sensitive content as live instructions (quarantine dates in a clearly-labelled history section).
- No committed secrets, real identifiers, or personal absolute paths.
- Scripts: handle errors, no magic constants, list dependencies, forward slashes only.
- Each critical skill/agent ships with **≥3 evaluation scenarios** (see `docs/sdlc/evals/`).
