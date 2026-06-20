# FlowScout — Vision Brief

_Owner-agreed product source of truth (captured by the planner). The analyst expands this into a RICE-ranked
roadmap + epics; the architect proposes the stack._

## Problem

Mobile teams routinely lack three things: **test coverage**, **product/workflow knowledge**, and the **QA
resources** to do manual or automated testing. Real apps accrete features and **hidden or duplicate workflows**
that nobody has documented, so testers and new developers don't know what exists or how flows actually work.

## Users

Internal **developers and testers** — especially on apps with thin documentation and low automated coverage.

## What FlowScout is

An agent-driven platform that, given **only an app name + a build**, autonomously explores a mobile app in a
**simulator via Mobile MCP**, semantically understands what the app is for, and **maps every end-to-end workflow**
(including hidden/duplicate paths) — then documents it as a grouped, browsable **HTML report**. Later it derives
the **test plans that should exist** and **authors + runs human-like automation tests** that become **release gates**.

## Value & differentiation

Unlike record/replay or monkey-testing tools (Appium, Maestro, etc.), FlowScout brings **semantic understanding**
(what the app is _for_), **zero-context autonomous discovery** (just the app name), **hidden/duplicate-path
surfacing**, and **auto-authored, maintained tests** — not scripted replay. It turns an undocumented app into
living docs + a regression gate without a human writing scripts.

## Scope

**MVP — Understand & Document (iOS):**

- iOS simulator; the user supplies a **simulator-compatible build (`.app`)**.
- Autonomous crawl: discover all options (visible **and** hidden), infer purpose, map end-to-end workflows.
- Grouped **HTML documentation** of features/workflows, surfacing duplicate/hidden paths.
- **Web dashboard:** enter an app/build, watch the crawl live, browse the workflow map / reports, manage runs & credentials.
- **Encrypted credential vault**; on 2FA/OTP, pause and ask the user, then continue.
- **Real data, fully autonomous** exploration (no destructive guardrails) — see Risks for mitigations.

**V1:** generate the proposed **automated test plans** from the map.
**V2:** **author + run** human-like automation tests; wire them as **release gates**; CI integration.

**Out of scope (now):** Android (post-MVP), automated OTP retrieval (email/SMS), app-store download, building our
own Mobile MCP, deployment target.

## Surface & constraints

- FlowScout's own UI = **web dashboard** (HTML report is a first-class view).
- **iOS-first**; Android later behind a platform abstraction.
- **Mobile MCP:** architect selects the best-maintained existing server (ADR); not locked yet.
- **App stack:** architect proposes (must support agent orchestration, Mobile MCP, iOS simulator control, and HTML reporting).
- Credentials: encrypted vault, reused across runs; secrets via env/secret store, never committed.

## Success metric

Given an **unknown iOS app build + its name**, FlowScout produces an **accurate, grouped HTML map** of its features
and end-to-end workflows — including **at least one hidden/duplicate path a human had missed** — with **no manual
scripting**, and a real dev/tester confirms it's accurate and useful.

## Assumptions

- iOS **simulators run `.app` (simulator) builds**, not store `.ipa` device builds — the user provides a simulator build.
- Autonomous exploration uses the accessibility tree **and** screenshot/vision; some surfaces (games, custom canvas) may map poorly.
- "Reuse credentials on future runs" implies secure persistent storage scoped per app.

## Risks

- **Fully-autonomous real-data exploration can cause real charges, data loss, or sent messages.** Owner accepts
  this; mitigations: **dedicated test accounts**, **sandbox/test environments**, and **disposable/snapshotted
  simulator state** so a destructive run can be reset. (No in-flow guardrails by decision.)
- Mobile MCP capability/maturity is a dependency risk (mitigate by isolating it behind an adapter).
- 2FA pause-and-ask means runs aren't fully unattended when an OTP appears.
- Semantic mapping of arbitrary apps is genuinely hard — MVP success is measured on a representative real app, not "every app".

## Open questions (for analyst/architect)

- Exact Mobile MCP choice + its coverage of gestures/deep state (architect ADR).
- How workflow "sameness" (duplicate paths to one outcome) is detected and represented in the map.
- Persistence/store for the crawl graph + reports (per-run history, diffing across app versions).
