# Agent Runtime Contract

OpenAgents should treat agent behavior as runtime contracts first, prompt text
second. Prompt rules are still useful, but they cannot be the only enforcement
layer for delivery, status, role boundaries, or task ownership.

## Layers

1. Protocol layer: messages, channel membership, mentions, and delivery rows are
   authoritative. If a message targets an agent, the backend creates a durable
   delivery row for that agent.
2. Runtime state layer: presence, activity, workload, leases, and ack state are
   separate fields. UI badges derive from these fields instead of overloading a
   single `status` string.
3. Work graph layer: multi-agent work should move through shared tasks with
   assignees, dependencies, claims, results, and acceptance, not private todo
   lists only.
4. Skill/rule layer: cold-start rules that every agent must follow should be
   packaged as installable skills or injected rule packs, then referenced by the
   runtime prompt.

## Delivery Rules

- `events` remains the conversation source of truth.
- `agent_deliveries` is the per-agent inbox and retry contract.
- A channel message creates one delivery row per channel agent participant.
- `delivery_kind=ambient` means the agent received the message for context but
  should not wake or answer.
- `delivery_kind=attention` means the agent was mentioned or routed to and
  should wake for work.
- A running agent leases its own pending attention rows using its current
  `session_id`. Ambient rows are available for future context packs and passive
  memory, but are not pulled into the execution loop by default.
- A delivery is acked only after the adapter finishes handling the message.
- If an agent exits before ack, the lease expires and the row becomes eligible
  for retry.
- Stale sessions cannot lease or ack deliveries.

## Skill/Rule Pack Direction

The baseline agent skill should contain rules that should not drift between
agents:

- Always reply in the exact channel/thread target that received the request.
- Mention another agent only when intentionally handing work to that agent.
- Claim shared tasks before implementation work.
- Keep role boundaries explicit: architect routes and accepts, implementers
  implement, reviewers verify, QA reproduces and retests.
- Report concrete state changes, test evidence, blockers, and handoff targets.

This file is the source note for turning those rules into a generated agent
skill/rule pack after the delivery and shared-task contracts are stable.

## Runtime Context Pack

Every attention delivery should be processed with a fresh server-provided
context pack. This is the runtime counterpart to human memory:

- The backend returns the current agent's role, description, status, channel,
  channel lead, team roster, recent channel messages, and passive ambient
  messages.
- Ambient rows are read as context only. Reading the pack must not lease, ack,
  or wake work.
- The connector injects this pack before each CLI execution. For fresh
  per-turn agents such as Codex it is appended to the system context; for
  persistent Claude sessions it is also prepended to the current user turn so a
  stale long-running process still sees the latest role/team state.
- Runtime rules in the pack are intentionally short and authoritative: channel
  visibility is not attention, @mentions are explicit handoffs, and role
  descriptions must drive delegation.

## Shared Workspace Tasks

Personal todos are not enough for team scheduling. OpenAgents uses shared
workspace tasks for ownership, claim, dependencies, status, result, and
acceptance:

- Scheduling is a rule, not a fixed org chart. The runtime should derive the
  needed work functions from the current request and channel context, then match
  those functions to agent descriptions, skills, and availability.
- Work functions are contextual examples, not permanent concepts. A bug may
  need analysis, fix, and testing. A feature may need reference research,
  design breakdown, and implementation. Other requests may need different
  functions.
- Create shared tasks for those work functions when separate owners improve
  clarity or throughput. If one owner can complete the work cleanly, keep it
  single-owner instead of splitting for its own sake.
- Agents use personal todos only for their private execution plan after they
  have a shared task or handoff.
