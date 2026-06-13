# Slock/Raft Agent Status Model

This project should not collapse every agent state into one `status` string.
Slock/Raft-like collaboration needs separate state dimensions so the UI and
scheduler can tell "connected", "working", "blocked", and "assigned" apart.

## State Dimensions

### Presence

`presence_status` describes connectivity only.

- `online`: the agent has a fresh heartbeat or active local control session.
- `offline`: the agent has no fresh heartbeat.
- `stopped`: the agent is intentionally disabled/stopped.

Heartbeat updates should only affect presence. They should not erase activity.

### Activity

`activity_state` describes what the agent is doing right now.

- `idle`: connected but not currently doing visible work.
- `starting`: local control is starting the agent.
- `thinking`: model turn is running without a more specific tool state.
- `running_command`: shell/tool command is running or just reported.
- `editing_file`: file edits are being applied.
- `waiting_input`: the agent is blocked on human or external input.
- `stopping`: local control is stopping the agent.
- `error`: the current run is blocked by an error.
- `offline` / `stopped`: mirrored when presence is unavailable.

Activity is produced by adapter events and must have a TTL or explicit clear.

### Workload

`workload_state` describes whether the agent owns active work.

- `active`: executing, thinking, editing, or assigned to an active channel/task.
- `waiting`: waiting for input but still owns the work.
- `blocked`: failed or cannot continue without intervention.
- `idle`: online with no active visible work.
- `offline` / `stopped`: unavailable.

Future task scheduling should key off workload, not raw presence.

## Compatibility Fields

Existing clients still receive `status` and `lifecycle_state`:

- `status` is a display compatibility value derived from the split model.
- `lifecycle_state` maps to `activity_state` for clients that already expect it.

New clients should prefer:

- `presenceStatus` / `presence_status`
- `activityState` / `activity_state`
- `workloadState` / `workload_state`
- `isConnected` / `is_connected`
- `hasActiveWork` / `has_active_work`

## Follow-Up Architecture

The next Slock/Raft parity layer should add durable delivery and task state:

- `agent_deliveries`: per-agent message delivery with lease, ack, retry, and error.
- `workspace_tasks`: task graph with owner, claim lease, deadline, dependency, result, and approval.
- context pack: role/profile, active task graph, thread summary, retrieved memory, and unresolved mentions injected before each turn.

These systems should use the split status model instead of interpreting
`online` as "working".
