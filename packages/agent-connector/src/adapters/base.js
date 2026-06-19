/**
 * Base adapter for OpenAgents workspace.
 *
 * Extracts the common connectivity logic shared by all adapters:
 * - Event cursor management and skip-existing-events on startup
 * - Heartbeat loop (30s)
 * - Adaptive poll loop with deduplication
 * - Control event polling (mode changes, stop)
 * - Per-channel task dispatch with queuing
 * - Auto-titling of new channels
 * - Graceful shutdown with disconnect
 *
 * Subclasses must implement _handleMessage(msg).
 *
 * Direct port of Python: sdk/src/openagents/adapters/base.py
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { WorkspaceClient, SessionRevokedError } = require('../workspace-client');
const { generateSessionTitle, SESSION_DEFAULT_RE } = require('./utils');
const { defaultAgentWorkdir } = require('../paths');
const { skillsDirForAgentType } = require('../skill-installer');

const DEFAULT_ENDPOINT = 'https://workspace-endpoint.openagents.org';
const DELIVERY_LEASE_SECONDS = 6 * 60 * 60;
const STALE_AGENT_QUEUE_MS = 30 * 1000;
const STATUS_DEDUPE_MS = 30 * 1000;
const GENERIC_STATUS_DEDUPE_MS = 2 * 60 * 1000;
const HUMAN_INTERRUPT_AFTER_MS = 10 * 60 * 1000;
const SELF_TASK_NUDGE_MS = 5 * 60 * 1000;
const SELF_TASK_NUDGE_WAIT_MARKERS = [
  'wait',
  'waiting',
  'blocked',
  '等待',
  '依赖',
  '阻塞',
];

class BaseAdapter {
  /**
   * @param {object} opts
   * @param {string} opts.workspaceId
   * @param {string} opts.channelName - default/initial channel
   * @param {string} opts.token
   * @param {string} opts.agentName
   * @param {string} [opts.endpoint]
   */
  constructor({ workspaceId, channelName, token, agentName, endpoint, agentEnv, agentType, workingDir }) {
    this.workspaceId = workspaceId;
    this.channelName = channelName;
    this.token = token;
    this.agentName = agentName;
    this.endpoint = endpoint || DEFAULT_ENDPOINT;
    this.agentEnv = agentEnv || process.env;
    this.agentType = agentType;
    this.workingDir = workingDir || undefined;
    this.client = new WorkspaceClient(this.endpoint);
    this._lastEventId = null;
    this._lastToolResultId = null;
    this._running = false;
    this._stopReason = null;
    this._sessionId = null;  // issued by server on /v1/join; used to prove liveness
    this._processedIds = new Set();
    this._inFlightIds = new Set();
    this._titledSessions = new Set();
    this._mode = 'execute';
    this._lastControlId = null;
    this._controlWake = null;
    this._deliveryLeaseSeconds = DELIVERY_LEASE_SECONDS;
    this._agentQueueTtlMs = Number.parseInt(this.agentEnv.OPENAGENTS_AGENT_QUEUE_TTL_MS || '', 10) || STALE_AGENT_QUEUE_MS;
    this._statusDedupeMs = Number.parseInt(this.agentEnv.OPENAGENTS_STATUS_DEDUPE_MS || '', 10) || STATUS_DEDUPE_MS;
    this._selfTaskNudgeMs = Number.parseInt(this.agentEnv.OPENAGENTS_SELF_TASK_NUDGE_MS || '', 10) || SELF_TASK_NUDGE_MS;
    this._lastSelfTaskNudgeAt = 0;
    this._selfTaskNudgeInFlight = false;
    this._recentStatusPosts = new Map();
    this._pendingProcessDetails = new Map();
    this._latestProcessDetails = new Map();
    // Per-channel task tracking for parallel execution
    this._channelBusy = new Set();
    this._channelBusySince = new Map();
    this._channelHumanInterrupting = new Set();
    this._channelQueues = {};
    // Cached workspace.browser_enabled. Populated lazily on first read so we
    // don't pay an HTTP roundtrip per message — adapters that toggle the
    // workspace flag must reconnect/restart to pick up the change (matches
    // the Python adapter behavior in workspace_prompt.py).
    this._browserEnabledCache = null;
    // Wall-clock timestamp of adapter init, used by the `status` control
    // action to report uptime back to the channel. Reset on reinstantiation
    // (e.g. after a `restart` IPC bounce) so uptime tracks "time since last
    // restart" rather than the long-running daemon's process uptime.
    this._startedAt = Date.now();
    this._log = (msg) => {
      const ts = new Date().toISOString();
      console.log(`${ts} INFO adapter [${this.agentName}]: ${msg}`);
    };
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  async run() {
    this._running = true;
    this._stopReason = null;

    // Announce agent to workspace
    try {
      const joinResult = await this.client.joinNetwork(this.agentName, this.token, {
        network: this.workspaceId,
        agentType: this.agentType || 'agent',
        serverHost: require('os').hostname(),
        workingDir: this.workingDir || defaultAgentWorkdir(this.agentName),
      });
      this._sessionId = (joinResult && joinResult.session_id) || null;
      this._log(`Joined workspace ${this.workspaceId}${this._sessionId ? ` (session ${this._sessionId.slice(0, 8)})` : ''}`);
    } catch (e) {
      this._log(`Warning: join failed: ${e.message} \nStack: ${e.stack}`);
    }

    // Sync workspace-managed skills into disabledModules
    try {
      const agents = await this.client.getAgents(this.workspaceId, this.token);
      const self = agents.find((a) => a.agentName === this.agentName);
      if (self && self.enabledSkills) {
        const { skillsToDisabledModules } = require('../skill-catalog');
        this.disabledModules = skillsToDisabledModules(self.enabledSkills);
        this._log(`Synced skills from workspace: disabled=[${[...this.disabledModules].join(',')}]`);
      }
    } catch (e) {
      this._log(`Warning: skill sync failed (non-fatal): ${e.message}`);
    }

    this._ensureRuntimeRuleSkill();
    await this._reportInstalledLocalSkills();

    // Fast-path operations (control-event cursor + heartbeat + control poll)
    // run BEFORE the message-cursor advance. Even though _skipExistingEvents
    // is fast on a healthy backend, we don't want slash commands gated on
    // its success — keeping these paths independent makes /restart and
    // /status responsive immediately after join.
    await this._skipExistingControlEvents();
    const heartbeatInterval = setInterval(() => this._heartbeat(), 30000);
    const controlPoller = this._controlPollerLoop();

    try {
      // Send initial heartbeat
      try { await this._heartbeat(); } catch (e) {
        this._log(`Heartbeat failed (non-fatal): ${e.message}`);
      }
      // Slow path: only the message-poll loop waits for this.
      await this._skipExistingEvents();
      this._log('Starting poll loop...');
      await this._pollLoop();
    } finally {
      this._running = false;
      this._wakeControlPoller();
      clearInterval(heartbeatInterval);
      try { await controlPoller; } catch {}
      try {
        await this.client.disconnect(this.workspaceId, this.agentName, this.token, this._sessionId);
      } catch {}
    }
  }

  stop() {
    this._running = false;
  }

  get stopReason() {
    return this._stopReason;
  }

  // ------------------------------------------------------------------
  // Event cursor / skip existing
  // ------------------------------------------------------------------

  async _skipExistingEvents() {
    // Jump straight to the head with one server call. Pagination from the
    // start was slow and brittle: on a busy workspace it could take many
    // minutes to chew through historical events 200 at a time, leaving the
    // agent silently behind, and a transient mid-paginate empty response
    // (e.g. shared-cache race) would strand the cursor at a non-head id.
    const head = await this.client.getHeadEventId(this.workspaceId, this.token);
    if (head) {
      this._lastEventId = head;
      this._log(`Skipped existing events, cursor at ${head}`);
    }
  }

  // ------------------------------------------------------------------
  // Heartbeat
  // ------------------------------------------------------------------

  async _heartbeat() {
    try {
      const activity = this._activityHeartbeatPayload();
      await this.client.heartbeat(
        this.workspaceId,
        this.agentName,
        this.token,
        this._sessionId,
        activity,
      );
    } catch (e) {
      if (e instanceof SessionRevokedError) {
        this._onSessionRevoked();
        return;
      }
      this._log(`Heartbeat failed: ${e.message}`);
    }
  }

  // ------------------------------------------------------------------
  // Control polling
  // ------------------------------------------------------------------

  /**
   * Advance `_lastControlId` past any pending control events for this agent
   * so we don't re-process them after a respawn. Without this, /restart
   * triggers a daemon bounce, the new adapter starts with _lastControlId=null,
   * polls and re-finds the same /restart event, bounces again — restart loop.
   */
  async _skipExistingControlEvents() {
    try {
      const events = await this.client.pollControl(
        this.workspaceId, this.agentName, this.token,
        { after: null }
      );
      if (events.length > 0) {
        // pollControl returns ascending-by-timestamp; take the latest.
        this._lastControlId = events[events.length - 1].id;
        this._log(`Skipped ${events.length} existing control event(s), cursor at ${this._lastControlId}`);
      }
    } catch {}
  }

  async _pollControl() {
    try {
      const events = await this.client.pollControl(
        this.workspaceId, this.agentName, this.token,
        { after: this._lastControlId }
      );
      for (const ev of events) {
        if (ev.id) this._lastControlId = ev.id;
        const payload = ev.payload || {};
        const action = payload.action;
        if (action === 'set_mode') {
          const newMode = payload.mode || 'execute';
          if ((newMode === 'execute' || newMode === 'plan') && newMode !== this._mode) {
            const oldMode = this._mode;
            this._mode = newMode;
            this._log(`Mode changed: ${oldMode} -> ${newMode}`);
          }
        } else {
          await this._onControlAction(action, payload);
        }
      }
    } catch {}
  }

  /**
   * Handle adapter-specific control actions. Override in subclasses to add
   * per-adapter actions (`stop`, `restart`, …); always call
   * `await super._onControlAction(action, payload)` from the override for
   * actions you don't recognize, so shared actions like `status` keep
   * working uniformly across adapter types.
   */
  async _onControlAction(action, payload) {
    if (action === 'status') {
      await this._postStatusReport(payload);
    } else if (action === 'routines') {
      await this._postRoutinesReport(payload);
    } else if (action === 'skill.install') {
      await this._handleSkillInstall(payload);
    } else if (action === 'skill.uninstall') {
      await this._handleSkillUninstall(payload);
    }
  }

  /**
   * Install a Skill Hub catalog skill into this agent's local skills
   * directory, then report the result back to the workspace so the UI can
   * show installing → installed / failed. Errors are logged loudly and
   * surfaced as a `failed` status — never swallowed.
   *
   * payload: { action: "skill.install", skill: { id, name, source_repo, source_path } }
   */
  async _handleSkillInstall(payload) {
    const installer = require('../skill-installer');
    const skill = (payload && payload.skill) || null;
    const skillId = skill && (skill.id || skill.skill_id);
    if (!skillId) {
      this._log('skill.install: missing skill metadata in payload — ignoring');
      return;
    }
    this._log(`skill.install: starting install of "${skillId}" (type=${this.agentType}, dir=${this.workingDir || defaultAgentWorkdir(this.agentName)})`);

    // Best-effort "installing" ping so the UI flips immediately even if the
    // initial DB write from the request hasn't propagated to this client.
    try {
      await this.client.reportSkillStatus(this.workspaceId, this.agentName, this.token, {
        skillId, state: 'installing',
      });
    } catch (e) {
      this._log(`skill.install: could not report 'installing' (non-fatal): ${e && e.message ? e.message : e}`);
    }

    try {
      const result = installer.installSkill({
        skill,
        agentType: this.agentType,
        workingDir: this.workingDir,
        log: (m) => this._log(`skill.install: ${m}`),
      });
      try {
        await this.client.reportSkillStatus(this.workspaceId, this.agentName, this.token, {
          skillId, state: 'installed', path: result.path, partial: result.partial === true,
        });
      } catch (e) {
        this._log(`skill.install: installed on disk but failed to report 'installed': ${e && e.message ? e.message : e}`);
      }
      this._log(`skill.install: SUCCESS "${skillId}" → ${result.path}${result.partial ? ' (partial)' : ''}`);
      await this._onSkillsChanged();
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      this._log(`skill.install: FAILED "${skillId}": ${msg}`);
      try {
        await this.client.reportSkillStatus(this.workspaceId, this.agentName, this.token, {
          skillId, state: 'failed', error: msg,
        });
      } catch (e2) {
        this._log(`skill.install: also failed to report 'failed': ${e2 && e2.message ? e2.message : e2}`);
      }
    }
  }

  /**
   * Remove a previously-installed skill from disk and report `uninstalled`.
   */
  async _handleSkillUninstall(payload) {
    const installer = require('../skill-installer');
    const skill = (payload && payload.skill) || null;
    const skillId = skill && (skill.id || skill.skill_id);
    if (!skillId) {
      this._log('skill.uninstall: missing skill metadata in payload — ignoring');
      return;
    }
    try {
      const result = installer.uninstallSkill({
        skill,
        agentType: this.agentType,
        workingDir: this.workingDir,
        log: (m) => this._log(`skill.uninstall: ${m}`),
      });
      this._log(`skill.uninstall: "${skillId}" removed=${result.removed}`);
      try {
        await this.client.reportSkillStatus(this.workspaceId, this.agentName, this.token, {
          skillId, state: 'uninstalled',
        });
      } catch (e) {
        this._log(`skill.uninstall: failed to report status: ${e && e.message ? e.message : e}`);
      }
      await this._onSkillsChanged();
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      this._log(`skill.uninstall: FAILED "${skillId}": ${msg}`);
    }
  }

  /**
   * Hook for subclasses to react to a change in the installed-skills set
   * (e.g. rebuild prompt context). Default: no-op.
   */
  async _onSkillsChanged() {}

  _ensureRuntimeRuleSkill() {
    try {
      const workDir = this.workingDir || defaultAgentWorkdir(this.agentName);
      const skillsDir = skillsDirForAgentType(this.agentType || 'agent', workDir);
      const runtimeDir = path.join(skillsDir, 'openagents-runtime');
      fs.mkdirSync(runtimeDir, { recursive: true });
      const { buildRuntimeRuleSkillMd } = require('./workspace-prompt');
      const skillPath = path.join(runtimeDir, 'SKILL.md');
      const content = buildRuntimeRuleSkillMd();
      let existing = null;
      try { existing = fs.readFileSync(skillPath, 'utf-8'); } catch {}
      if (existing !== content) {
        fs.writeFileSync(skillPath, content, 'utf-8');
      }
      this._runtimeRuleSkillPath = skillPath;
      this._log(`Ensured runtime rule skill: ${skillPath}`);
    } catch (e) {
      this._log(`Warning: runtime rule skill unavailable: ${e && e.message ? e.message : e}`);
    }
  }

  async _reportInstalledLocalSkills() {
    let skills = [];
    try {
      const installer = require('../skill-installer');
      skills = installer.listInstalledSkills({
        agentType: this.agentType || 'agent',
        workingDir: this.workingDir || defaultAgentWorkdir(this.agentName),
      });
    } catch (e) {
      this._log(`Warning: local skill scan failed: ${e && e.message ? e.message : e}`);
      return;
    }
    if (!skills.length) return;

    for (const skill of skills) {
      try {
        await this.client.reportSkillStatus(this.workspaceId, this.agentName, this.token, {
          skillId: skill.id,
          state: 'installed',
          path: skill.path,
        });
      } catch (e) {
        this._log(`Warning: failed to report local skill "${skill.id}": ${e && e.message ? e.message : e}`);
      }
    }
  }

  /**
   * Post a chat message back to the requesting channel summarizing agent
   * name, type, agent-launcher version, uptime, and network. Used by the
   * `/status` slash command.
   */
  async _postStatusReport(payload) {
    const channel = (payload && typeof payload === 'object') ? payload.channel : null;
    if (!channel) return;

    let pkgVersion = 'unknown';
    try {
      const path = require('path');
      const pkg = require(path.join(__dirname, '..', '..', 'package.json'));
      pkgVersion = pkg.version || 'unknown';
    } catch {}

    const uptimeMs = Math.max(0, Date.now() - this._startedAt);
    const totalSec = Math.floor(uptimeMs / 1000);
    const days = Math.floor(totalSec / 86400);
    const hours = Math.floor((totalSec % 86400) / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    const seconds = totalSec % 60;
    let uptime;
    if (days > 0) uptime = `${days}d ${hours}h ${minutes}m`;
    else if (hours > 0) uptime = `${hours}h ${minutes}m`;
    else if (minutes > 0) uptime = `${minutes}m ${seconds}s`;
    else uptime = `${seconds}s`;

    const adapterType = this.agentType || 'unknown';
    const content =
      `**Agent status**\n` +
      `- Name: \`${this.agentName}\` (${adapterType})\n` +
      `- Version: agent-launcher \`${pkgVersion}\`\n` +
      `- Uptime: ${uptime}\n` +
      `- Network: \`${this.workspaceId}\``;

    try {
      await this.client.sendMessage(this.workspaceId, channel, this.token, content, {
        senderType: 'agent',
        senderName: this.agentName,
        messageType: 'chat',
        metadata: { agent_mode: this._mode },
        sessionId: this._sessionId,
      });
    } catch (e) {
      this._log(`Status: failed to post: ${e && e.message ? e.message : e}`);
    }
  }

  /**
   * Post a markdown table of the agent's active routines back to the
   * requesting channel. Used by the `/routines` slash command. Each agent
   * reports only routines it owns (created_by === openagents:<agentName>)
   * so the user sees a clear "my routines" view per agent, mirroring how
   * /status reports per-agent uptime.
   */
  async _postRoutinesReport(payload) {
    const channel = (payload && typeof payload === 'object') ? payload.channel : null;
    if (!channel) return;

    let routines = [];
    try {
      const data = await this.client.listRoutines(this.workspaceId, channel, this.token);
      // Accept both the canonical `openagents:<name>` source and the bare
      // `<name>` form. Agents that follow the workspace prompt verbatim
      // produce the prefixed form, but some agents send the bare name when
      // they construct the POST body themselves.
      const prefixed = `openagents:${this.agentName}`;
      routines = ((data && data.routines) || []).filter(
        (r) => r.created_by === prefixed || r.created_by === this.agentName,
      );
    } catch (e) {
      this._log(`Routines: failed to list: ${e && e.message ? e.message : e}`);
      try {
        await this.client.sendMessage(
          this.workspaceId, channel, this.token,
          `**Routines for \`${this.agentName}\`**\n\n_Failed to fetch routines._`,
          { senderType: 'agent', senderName: this.agentName, messageType: 'chat', sessionId: this._sessionId },
        );
      } catch {}
      return;
    }

    let content;
    if (!routines.length) {
      content = `**Routines for \`${this.agentName}\`**\n\n_No active routines._`;
    } else {
      const rows = routines.map((r) => {
        const schedule = (r.schedule_interval_minutes != null)
          ? `every ${r.schedule_interval_minutes} min`
          : `${String(r.schedule_hour ?? 0).padStart(2, '0')}:${String(r.schedule_minute ?? 0).padStart(2, '0')} UTC` +
            (r.schedule_days ? ` (days [${r.schedule_days.join(',')}])` : ' daily');
        const next = r.next_fires_at || '—';
        const name = String(r.name || '').replace(/\|/g, '\\|');
        const id = String(r.id || '').slice(0, 8);
        return `| \`${id}\` | ${name} | ${schedule} | ${next} |`;
      });
      content =
        `**Routines for \`${this.agentName}\`** (${routines.length})\n\n` +
        '| ID | Name | Schedule | Next fires |\n' +
        '|---|---|---|---|\n' +
        rows.join('\n');
    }

    try {
      await this.client.sendMessage(this.workspaceId, channel, this.token, content, {
        senderType: 'agent',
        senderName: this.agentName,
        messageType: 'chat',
        metadata: { agent_mode: this._mode },
        sessionId: this._sessionId,
      });
    } catch (e) {
      this._log(`Routines: failed to post: ${e && e.message ? e.message : e}`);
    }
  }

  _hasActiveWork() {
    return this._channelBusy.size > 0;
  }

  _activityHeartbeatPayload() {
    if (!this._hasActiveWork()) {
      return { activity_state: 'idle' };
    }

    const channel = [...this._channelBusy][0] || this.channelName;
    const detail = channel ? this._latestProcessDetails.get(channel) : null;
    if (!detail) {
      return {
        activity_state: 'thinking',
        activity_summary: '处理中',
        current_channel: channel,
      };
    }

    const kind = String(detail.kind || '').toLowerCase();
    const state = kind === 'command'
      ? 'running_command'
      : kind === 'edit' || kind === 'file_change'
        ? 'editing_file'
        : 'thinking';
    const label = String(detail.label || '过程').trim() || '过程';
    const value = String(detail.value || '').trim();
    const summary = value ? `${label}: ${value}` : label;
    return {
      activity_state: state,
      activity_summary: summary.length > 240 ? `${summary.slice(0, 237)}...` : summary,
      activity_details: [detail],
      current_channel: channel,
    };
  }

  _controlPollDelayMs() {
    return this._hasActiveWork() ? 250 : 2000;
  }

  _wakeControlPoller() {
    if (this._controlWake) {
      this._controlWake();
      this._controlWake = null;
    }
  }

  async _sleepUntilControlPollDue(delayMs) {
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, delayMs);
      this._controlWake = () => {
        clearTimeout(timeout);
        resolve();
      };
    });
    this._controlWake = null;
  }

  async _controlPollerLoop() {
    while (this._running) {
      await this._pollControl();
      if (!this._running) break;
      await this._sleepUntilControlPollDue(this._controlPollDelayMs());
    }
  }

  // ------------------------------------------------------------------
  // Poll loop
  // ------------------------------------------------------------------

  async _pollLoop() {
    let idleCount = 0;
    let pollCount = 0;

    while (this._running) {
      pollCount++;
      let messages, rawCursor, composingActive = false;
      try {
        const result = await this.client.pollPending(
          this.workspaceId, this.agentName, this.token,
          {
            after: this._lastEventId,
            sessionId: this._sessionId,
            // Keep normal long-running tasks from being re-leased while they
            // are still executing. A fresh agent session can still reclaim
            // the lease immediately server-side after a process restart.
            leaseSeconds: this._deliveryLeaseSeconds,
            includeAmbient: true,
          }
        );
        messages = result.messages;
        rawCursor = result.cursor;
        composingActive = !!result.composing;
        if (pollCount <= 3 || pollCount % 20 === 0) {
          this._log(`Poll #${pollCount}: ${messages.length} messages, cursor=${rawCursor || 'none'}${composingActive ? ' composing' : ''}`);
        }
      } catch (e) {
        this._log(`Poll #${pollCount} failed: ${e.message} \nStack: ${e.stack}`);
        await this._sleep(5000);
        continue;
      }

      if (rawCursor) this._lastEventId = rawCursor;

      // Deduplicate
      const incoming = [];
      for (const msg of messages) {
        if (this._isProcessedMessage(msg)) {
          await this._ackMessage(msg);
          continue;
        }
        if (this._isInFlightMessage(msg)) {
          // Durable polling may re-lease the same message after its lease
          // expires while the agent is still working. Treat that as a lease
          // renewal, not a second work item. Do not ack yet; the active worker
          // owns final completion/failure.
          continue;
        }
        const msgId = msg.id || msg.messageId;
        if (msg.messageType === 'status') {
          if (msgId) this._processedIds.add(msgId);
          await this._ackMessage(msg);
          continue;
        }
        // Handle queue cancellation signals from frontend
        if (msg.messageType === 'queue_cancel') {
          if (msgId) this._processedIds.add(msgId);
          const channel = msg.sessionId || this.channelName || 'general';
          const queueId = msg.metadata?.queue_id || (msg.content || '').replace('__queue_cancel:', '');
          if (queueId) await this._cancelQueuedMessage(channel, queueId);
          await this._ackMessage(msg);
          continue;
        }
        incoming.push(msg);
      }

      if (incoming.length > 0) {
        idleCount = 0;
        for (const msg of incoming) {
          await this._dispatchMessage(msg);
        }
        // Cap dedup set
        if (this._processedIds.size > 2000) {
          const arr = [...this._processedIds];
          this._processedIds.clear();
          for (const id of arr.slice(-1000)) this._processedIds.add(id);
        }
      } else {
        idleCount++;
        if (!composingActive) {
          await this._maybeDispatchSelfTaskNudge();
        }
      }

      // Sidecar poll: A2UI tool_result events. These are the user's response
      // to a UI spec this agent (or any agent in the network) emitted. We
      // surface each one as a synthetic user message so the LLM sees it as
      // the next turn and can react. Failures here don't break the main
      // message poll.
      try {
        const toolResult = await this.client.pollToolResults(
          this.workspaceId, this.token,
          { after: this._lastToolResultId }
        );
        if (toolResult.cursor) this._lastToolResultId = toolResult.cursor;
        for (const event of toolResult.events || []) {
          const msgId = event.id;
          if (msgId && this._processedIds.has(msgId)) continue;
          if (msgId) this._processedIds.add(msgId);
          const synth = synthesizeToolResultMessage(event);
          if (synth) await this._dispatchMessage(synth);
        }
      } catch (e) {
        // Non-fatal — log once per poll if it fails
        if (pollCount <= 3 || pollCount % 20 === 0) {
          this._log(`tool_result poll #${pollCount} failed: ${e.message}`);
        }
      }

      // Adaptive polling with warm plateau:
      //   Active (messages incoming):  2s
      //   Warm (≤5 min since last msg): 5s
      //   Cooldown (5-7 min):          5s → 15s (ramp 1s per idle poll)
      //   Cold (>7 min):              15s
      // The warm plateau keeps the agent responsive during typical user
      // think-time between messages without hammering the backend.
      const WARM_INTERVAL = 5000;
      const WARM_POLLS = 60;  // 60 × 5s = 5 minutes warm plateau
      let delay;
      if (incoming.length > 0) {
        delay = 2000;
      } else if (composingActive) {
        delay = 2000;
        idleCount = Math.min(idleCount, WARM_POLLS);
      } else if (idleCount <= WARM_POLLS) {
        delay = WARM_INTERVAL;
      } else {
        delay = Math.min(WARM_INTERVAL + (idleCount - WARM_POLLS) * 1000, 15000);
      }
      await this._sleep(delay);
    }
  }

  // ------------------------------------------------------------------
  // Channel dispatch
  // ------------------------------------------------------------------

  async _dispatchMessage(msg) {
    // Use sessionId only if it looks like a channel, not an agent target
    let channel = this.channelName || 'general';
    if (msg.sessionId && !msg.sessionId.startsWith('openagents:') && !msg.sessionId.startsWith('agent:')) {
      channel = msg.sessionId;
    }

    this._markMessageInFlight(msg);

    if (msg._deliveryKind === 'ambient') {
      this._log(`Absorbing ambient delivery for channel ${channel}`);
      await this._ackMessage(msg);
      this._clearMessageInFlight(msg);
      return;
    }

    if (this._channelBusy.has(channel)) {
      if (!this._channelQueues[channel]) this._channelQueues[channel] = [];
      const queueId = `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      msg._queueId = queueId;
      msg._queuedAt = Date.now();
      this._enqueueChannelMessage(channel, msg);
      if ((msg.senderType || '') !== 'agent') {
        try {
          await this.sendStatus(channel, 'message queued — will process after current task', {
            queued_message: (msg.content || '').slice(0, 200),
            queue_id: queueId,
          });
        } catch {}
        await this._maybeInterruptBusyChannelForHuman(channel, msg);
      } else {
        this._log(`Queued message ${queueId} in ${channel}`);
      }
      return;
    }

    // Run channel worker (don't await — parallel execution)
    this._channelWorker(channel, msg);
    this._wakeControlPoller();
  }

  _queuedMessagePriority(msg) {
    const senderType = String(msg && msg.senderType || '').toLowerCase();
    if (senderType === 'human') return 0;
    if (senderType && senderType !== 'agent') return 1;
    if (String(msg && msg._deliveryKind || '').toLowerCase() === 'attention') return 2;
    return 3;
  }

  _enqueueChannelMessage(channel, msg) {
    if (!this._channelQueues[channel]) this._channelQueues[channel] = [];
    const queue = this._channelQueues[channel];
    const priority = this._queuedMessagePriority(msg);
    const idx = queue.findIndex((queued) => this._queuedMessagePriority(queued) > priority);
    if (idx === -1) {
      queue.push(msg);
    } else {
      queue.splice(idx, 0, msg);
    }
  }

  _taskLooksWaiting(task) {
    const text = [
      task && task.title,
      task && task.description,
      task && task.result,
    ].filter(Boolean).join('\n').toLowerCase();
    return SELF_TASK_NUDGE_WAIT_MARKERS.some((marker) => text.includes(marker));
  }

  _selectSelfTaskNudge(tasks) {
    const active = (tasks || []).filter((task) => {
      if (!task || task.status !== 'in_progress') return false;
      const owner = task.claimed_by || task.claimedBy || task.assignee;
      if (owner !== this.agentName) return false;
      return !this._taskLooksWaiting(task);
    });
    if (!active.length) return null;
    active.sort((a, b) => {
      const au = Date.parse(a.updated_at || a.updatedAt || a.claimed_at || a.claimedAt || a.created_at || a.createdAt || '') || 0;
      const bu = Date.parse(b.updated_at || b.updatedAt || b.claimed_at || b.claimedAt || b.created_at || b.createdAt || '') || 0;
      return au - bu;
    });
    return active[0];
  }

  async _maybeDispatchSelfTaskNudge() {
    if (this._selfTaskNudgeMs <= 0) return false;
    if (this._selfTaskNudgeInFlight) return false;
    if (Date.now() - this._lastSelfTaskNudgeAt < this._selfTaskNudgeMs) return false;
    if (this._channelBusy.size > 0) return false;

    this._selfTaskNudgeInFlight = true;
    try {
      const result = await this.client.listWorkspaceTasks(
        this.workspaceId,
        null,
        this.token,
        { assignee: this.agentName, active: true },
      );
      const tasks = (result && (result.tasks || result.items || result.data)) || [];
      const task = this._selectSelfTaskNudge(tasks);
      if (!task) {
        this._lastSelfTaskNudgeAt = Date.now();
        return false;
      }

      this._lastSelfTaskNudgeAt = Date.now();
      const channel = task.channel_name || task.channelName || this.channelName || 'general';
      const taskId = task.id || task.task_id || '';
      const title = task.title || 'active workspace task';
      this._log(`Self-nudging active task ${taskId || title} in ${channel}`);
      await this._dispatchMessage({
        messageId: `self-task-nudge:${this.agentName}:${taskId || title}:${this._lastSelfTaskNudgeAt}`,
        sessionId: channel,
        senderType: 'system',
        senderName: 'system:self-task-nudge',
        messageType: 'chat',
        content: [
          `Self-check: you still own an in-progress workspace task: ${taskId ? `${taskId} — ` : ''}${title}.`,
          'Continue it now, or explicitly update the task to waiting/blocked/done with evidence.',
          'Before changing files, reconcile the current task board, recent messages, and repository state.',
        ].join('\n'),
        metadata: { self_task_nudge: true, task_id: taskId },
      });
      return true;
    } catch (e) {
      this._log(`Self task nudge failed: ${e && e.message ? e.message : e}`);
      this._lastSelfTaskNudgeAt = Date.now();
      return false;
    } finally {
      this._selfTaskNudgeInFlight = false;
    }
  }

  async _maybeInterruptBusyChannelForHuman(channel, msg) {
    if (String(msg && msg.senderType || '').toLowerCase() !== 'human') return false;
    const thresholdMs = Number.parseInt(this.agentEnv.OPENAGENTS_HUMAN_INTERRUPT_AFTER_MS || '', 10) || HUMAN_INTERRUPT_AFTER_MS;
    if (thresholdMs <= 0) return false;
    const busySince = this._channelBusySince.get(channel);
    if (!busySince) return false;
    const busyMs = Date.now() - busySince;
    if (busyMs < thresholdMs) return false;
    if (this._channelHumanInterrupting.has(channel)) return false;

    this._channelHumanInterrupting.add(channel);
    try {
      const interrupted = await this._interruptChannelForHuman(channel, msg, { busyMs, thresholdMs });
      if (interrupted) {
        this._log(`Interrupted busy channel ${channel} after ${Math.round(busyMs / 1000)}s for human message ${msg.messageId || msg.id || msg._queueId || ''}`);
      }
      return interrupted;
    } catch (e) {
      this._log(`Human interrupt failed for ${channel}: ${e && e.message ? e.message : e}`);
      return false;
    } finally {
      this._channelHumanInterrupting.delete(channel);
    }
  }

  async _interruptChannelForHuman(_channel, _msg, _context) {
    return false;
  }

  async _cancelQueuedMessage(channel, queueId) {
    const queue = this._channelQueues[channel];
    if (!queue) return false;
    const idx = queue.findIndex((m) => m._queueId === queueId);
    if (idx === -1) return false;
    const [cancelled] = queue.splice(idx, 1);
    this._clearMessageInFlight(cancelled);
    await this._ackMessage(cancelled);
    this._log(`Cancelled queued message ${queueId} in ${channel}`);
    return true;
  }

  async _channelWorker(channel, msg) {
    this._channelBusy.add(channel);
    this._channelBusySince.set(channel, Date.now());
    try {
      await this._handleMessage(msg);
      await this._ackMessage(msg);
      this._clearMessageInFlight(msg);
    } catch (e) {
      this._log(`Error in channel worker for ${channel}: ${e.message}`);
      try { await this.sendError(channel, `Agent error: ${e.message}`); } catch {}
      await this._failMessage(msg, e);
      this._clearMessageInFlight(msg);
    }

    // Drain queue
    while (true) {
      const queue = this._channelQueues[channel];
      if (!queue || queue.length === 0) break;
      const nextMsg = queue.shift();
        if (nextMsg._queueId && (nextMsg.senderType || '') !== 'agent') {
          try { await this.sendStatus(channel, 'processing queued message', { queue_id: nextMsg._queueId, queue_status: 'processed' }); } catch {}
        } else if (nextMsg._queueId) {
          this._log(`Processing queued message ${nextMsg._queueId} in ${channel}`);
        }
      try {
        await this._handleMessage(nextMsg);
        await this._ackMessage(nextMsg);
        this._clearMessageInFlight(nextMsg);
      } catch (e) {
        this._log(`Error processing queued message in ${channel}: ${e.message}`);
        try { await this.sendError(channel, `Agent error: ${e.message}`); } catch {}
        await this._failMessage(nextMsg, e);
        this._clearMessageInFlight(nextMsg);
      }
    }
    this._channelBusy.delete(channel);
    this._channelBusySince.delete(channel);
  }

  // ------------------------------------------------------------------
  // Auto-title helper
  // ------------------------------------------------------------------

  async _autoTitleChannel(channel, content) {
    if (this._titledSessions.has(channel)) return;
    this._titledSessions.add(channel);
    const title = generateSessionTitle(content);
    if (!title) return;
    try {
      const info = await this.client.getSession(this.workspaceId, channel, this.token);
      if (!info.titleManuallySet && SESSION_DEFAULT_RE.test(info.title || '')) {
        await this.client.updateSession(
          this.workspaceId, channel, this.token,
          { title, autoTitle: true }
        );
        this._log(`Auto-titled channel: ${title}`);
      }
    } catch (e) {
      this._log(`Failed to auto-title channel: ${e.message}`);
    }
  }

  // ------------------------------------------------------------------
  // Message helpers
  // ------------------------------------------------------------------

  async _ackMessage(msg) {
    const msgId = msg && (msg.id || msg.messageId);
    if (msgId) this._processedIds.add(msgId);
    if (!msg || !msg._deliveryId) return;
    try {
      await this.client.ackDelivery(
        this.workspaceId,
        this.agentName,
        this.token,
        msg._deliveryId,
        this._sessionId,
      );
    } catch (e) {
      if (e instanceof SessionRevokedError) {
        this._onSessionRevoked();
        return;
      }
      this._log(`Delivery ack failed for ${msg._deliveryId}: ${e.message}`);
    }
  }

  _messageKeys(msg) {
    const keys = [];
    if (!msg) return keys;
    const msgId = msg.id || msg.messageId;
    if (msgId) keys.push(`event:${msgId}`);
    if (msg._deliveryId) keys.push(`delivery:${msg._deliveryId}`);
    return keys;
  }

  _isProcessedMessage(msg) {
    const msgId = msg && (msg.id || msg.messageId);
    return !!(msgId && this._processedIds.has(msgId));
  }

  _isInFlightMessage(msg) {
    return this._messageKeys(msg).some((key) => this._inFlightIds.has(key));
  }

  _markMessageInFlight(msg) {
    for (const key of this._messageKeys(msg)) this._inFlightIds.add(key);
  }

  _clearMessageInFlight(msg) {
    for (const key of this._messageKeys(msg)) this._inFlightIds.delete(key);
  }

  async _failMessage(msg, error) {
    if (!msg || !msg._deliveryId) return;
    const attempts = Number(msg._deliveryAttempts || 0);
    const status = attempts >= 3 ? 'acked' : 'failed';
    try {
      await this.client.ackDelivery(
        this.workspaceId,
        this.agentName,
        this.token,
        msg._deliveryId,
        this._sessionId,
        {
          status,
          error: error && error.message ? error.message : String(error || 'processing failed'),
        },
      );
      if (status === 'acked') {
        const msgId = msg.id || msg.messageId;
        if (msgId) this._processedIds.add(msgId);
      }
    } catch (e) {
      if (e instanceof SessionRevokedError) {
        this._onSessionRevoked();
        return;
      }
      this._log(`Delivery failure ack failed for ${msg._deliveryId}: ${e.message}`);
    }
  }

  async sendStatus(channel, content, extraMeta) {
    const cleanContent = this._sanitizeStatusContent(content);
    if (!cleanContent) return;
    const metadata = this._sanitizeStatusMetadata({ agent_mode: this._mode, ...extraMeta });
    if (this._shouldSuppressStatus(channel, cleanContent, metadata)) {
      this._recordProcessDetail(channel, this._processDetailFromStatus(cleanContent, metadata));
      return;
    }
    try {
      await this.client.sendMessage(this.workspaceId, channel, this.token, cleanContent, {
        senderType: 'agent',
        senderName: this.agentName,
        messageType: 'status',
        metadata,
        sessionId: this._sessionId,
      });
    } catch (e) {
      if (e instanceof SessionRevokedError) this._onSessionRevoked();
    }
  }

  _statusDedupeWindowMs(content) {
    if (/workspace api request/i.test(content)) return GENERIC_STATUS_DEDUPE_MS;
    if (/git status --short --branch/i.test(content)) return GENERIC_STATUS_DEDUPE_MS;
    if (/^message queued|^processing queued/i.test(content)) return GENERIC_STATUS_DEDUPE_MS;
    if (/^\*\*(?:Running|Editing):\*\*/i.test(content)) return this._statusDedupeMs;
    return this._statusDedupeMs;
  }

  _statusDedupeKey(channel, content) {
    if (/workspace api request/i.test(content)) return `${channel || ''}\n<workspace-api-status>`;
    return `${channel || ''}\n${content}`;
  }

  _shouldSuppressStatus(channel, content, metadata) {
    const key = this._statusDedupeKey(channel, content);
    const now = Date.now();
    const windowMs = this._statusDedupeWindowMs(content);
    const previous = this._recentStatusPosts.get(key);
    if (previous && now - previous < windowMs) return true;
    this._recentStatusPosts.set(key, now);
    if (this._recentStatusPosts.size > 200) {
      const cutoff = now - Math.max(windowMs, GENERIC_STATUS_DEDUPE_MS);
      for (const [entryKey, ts] of this._recentStatusPosts) {
        if (ts < cutoff) this._recentStatusPosts.delete(entryKey);
      }
    }
    return false;
  }

  _sanitizeStatusContent(content) {
    const text = this._redactSensitiveText(content).trim();
    if (!text) return '';
    if (/^thinking(?:\.\.\.)?$/i.test(text)) return '';
    if (text.length <= 1000) return text;
    return `${text.slice(0, 997)}...`;
  }

  _sanitizeStatusMetadata(value) {
    if (typeof value === 'string') return this._redactSensitiveText(value);
    if (Array.isArray(value)) return value.map((entry) => this._sanitizeStatusMetadata(entry));
    if (value && typeof value === 'object') {
      const result = {};
      for (const [key, entry] of Object.entries(value)) {
        result[key] = this._sanitizeStatusMetadata(entry);
      }
      return result;
    }
    return value;
  }

  _processDetailFromStatus(content, metadata = {}) {
    const running = String(content || '').match(/\*\*Running:\*\*\s*`([^`]+)`(?:\s*\(exit\s*([^)]+)\))?/i);
    if (running) {
      const detail = { kind: 'command', label: '命令', value: running[1] };
      if (running[2]) detail.exit_code = running[2];
      return detail;
    }
    const editing = String(content || '').match(/\*\*Editing:\*\*\s*`([^`]+)`/i);
    if (editing) return { kind: 'edit', label: '编辑', value: editing[1] };
    return {
      kind: 'status',
      label: metadata && metadata.queue_status ? '队列状态' : '状态',
      value: content,
    };
  }

  _recordProcessDetail(channel, detail) {
    if (!channel || !detail || typeof detail !== 'object') return;
    const value = this._redactSensitiveText(detail.value || detail.content || detail.text || '').trim();
    if (!value) return;
    const label = this._redactSensitiveText(detail.label || detail.kind || '过程').trim() || '过程';
    const clean = {
      ...detail,
      label: label.slice(0, 40),
      value: value.length > 1000 ? `${value.slice(0, 997)}...` : value,
      at: detail.at || new Date().toISOString(),
    };
    const list = this._pendingProcessDetails.get(channel) || [];
    list.push(this._sanitizeStatusMetadata(clean));
    this._pendingProcessDetails.set(channel, list.slice(-40));
    this._latestProcessDetails.set(channel, clean);
  }

  _drainProcessDetails(channel) {
    const list = this._pendingProcessDetails.get(channel) || [];
    this._pendingProcessDetails.delete(channel);
    this._latestProcessDetails.delete(channel);
    return list;
  }

  _redactSensitiveText(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/\b(sk_(?:agent|machine))_[A-Za-z0-9_-]+/g, '$1_<redacted>')
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1<redacted>')
      .replace(/((?:X-Workspace-Token|Authorization|OPENAI_API_KEY|ANTHROPIC_API_KEY|CLAUDE_API_KEY|GEMINI_API_KEY|API[_-]?KEY|TOKEN|token)['"]?\s*[:=]\s*['"]?)[^'"\s,;}]+/gi, '$1<redacted>')
      .replace(/((?:X-Workspace-Token|Authorization|OPENAI_API_KEY|ANTHROPIC_API_KEY|CLAUDE_API_KEY|GEMINI_API_KEY|API[_-]?KEY|TOKEN|token)[^:=\n\r]{0,40}[:=]\s*['"]?)[A-Za-z0-9._~+/-]{16,}['"]?/gi, '$1<redacted>')
      .replace(/((?:X-Workspace-Token|Authorization|OPENAI_API_KEY|ANTHROPIC_API_KEY|CLAUDE_API_KEY|GEMINI_API_KEY|API[_-]?KEY|TOKEN|token)['"]?\s*=>?\s*['"]?)[A-Za-z0-9._~+/-]{16,}['"]?/gi, '$1<redacted>')
      .replace(/((?:X-Workspace-Token|Authorization|OPENAI_API_KEY|ANTHROPIC_API_KEY|CLAUDE_API_KEY|GEMINI_API_KEY|API[_-]?KEY|TOKEN|token)['"]?\s*,\s*['"]?)[A-Za-z0-9._~+/-]{16,}['"]?/gi, '$1<redacted>');
  }

  async sendThinking(channel, content) {
    // Strip ```a2ui blocks if they leak into Claude's intermediate thinking
    // trace — the real spec gets emitted via sendResponse with proper
    // payload.spec extraction, so showing the raw block here is just noise
    // (and a duplicate). If stripping leaves the thinking message empty,
    // skip it entirely.
    const { cleanContent } = extractA2UISpec(content);
    if (!cleanContent || !cleanContent.trim()) return;
    if (this._isNoResponseText(cleanContent)) return;
    try {
      await this.client.sendMessage(this.workspaceId, channel, this.token, cleanContent, {
        senderType: 'agent',
        senderName: this.agentName,
        messageType: 'thinking',
        metadata: { agent_mode: this._mode },
        sessionId: this._sessionId,
      });
    } catch (e) {
      if (e instanceof SessionRevokedError) this._onSessionRevoked();
    }
  }

  async sendResponse(channel, content, opts = {}) {
    const { cleanContent, spec, specToolCallId } = extractA2UISpec(content);
    const suppliedDetails = Array.isArray(opts.details) ? opts.details : [];
    const details = [...this._drainProcessDetails(channel), ...suppliedDetails]
      .filter((detail) => detail && typeof detail === 'object')
      .map((detail) => this._sanitizeStatusMetadata(detail));
    try {
      await this.client.sendMessage(this.workspaceId, channel, this.token, cleanContent, {
        senderType: 'agent',
        senderName: this.agentName,
        sessionId: this._sessionId,
        spec,
        specToolCallId,
        details,
      });
    } catch (e) {
      if (e instanceof SessionRevokedError) {
        this._onSessionRevoked();
        return;
      }
      throw e;
    }
  }

  async cleanupTodos(channel) {
    try {
      const result = await this.client.getTodos(this.workspaceId, channel, this.token, {
        all: false,
      });
      const todos = (result && result.todos) || [];
      const hasActive = todos.some((t) => t.status === 'pending' || t.status === 'in_progress');
      if (!hasActive) return;
      const updated = todos.map((t) => ({
        content: t.content,
        status: (t.status === 'pending' || t.status === 'in_progress') ? 'cancelled' : t.status,
        assignee: t.assignee,
      }));
      await this.client.putTodos(this.workspaceId, channel, this.token, updated, {
        source: `openagents:${this.agentName}`,
      });
    } catch {
      // Best-effort cleanup
    }
  }

  async getRemainingTodos(channel) {
    try {
      const result = await this.client.getTodos(this.workspaceId, channel, this.token, {
        all: false,
      });
      const todos = (result && result.todos) || [];
      return todos.filter((t) => t.status === 'pending' || t.status === 'in_progress');
    } catch {
      return [];
    }
  }

  async sendTodos(channel, todos) {
    try {
      await this.client.putTodos(this.workspaceId, channel, this.token, todos, {
        source: `openagents:${this.agentName}`,
      });
    } catch (e) {
      if (e instanceof SessionRevokedError) { this._onSessionRevoked(); return; }
      // Fallback to event-based approach for older backends
      const lines = todos.map((t) => {
        const icon = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⬜';
        return `${icon} ${t.content}`;
      });
      try {
        await this.client.sendMessage(this.workspaceId, channel, this.token, lines.join('\n'), {
          senderType: 'agent',
          senderName: this.agentName,
          messageType: 'todos',
          metadata: { agent_mode: this._mode, todos },
          sessionId: this._sessionId,
        });
      } catch (e2) {
        if (e2 instanceof SessionRevokedError) this._onSessionRevoked();
      }
    }
  }

  async sendError(channel, error) {
    try {
      await this.client.sendMessage(this.workspaceId, channel, this.token, error, {
        senderType: 'agent',
        senderName: this.agentName,
        sessionId: this._sessionId,
      });
    } catch (e) {
      if (e instanceof SessionRevokedError) this._onSessionRevoked();
    }
  }

  _onSessionRevoked() {
    this._log(`SESSION REVOKED: another client joined as '${this.agentName}'. Stopping adapter.`);
    this._stopReason = 'session_revoked';
    this._running = false;
  }

  // ------------------------------------------------------------------
  // Abstract
  // ------------------------------------------------------------------

  /**
   * Process a single incoming message. Must be implemented by subclasses.
   * @param {object} msg
   */
  async _handleMessage(_msg) {
    throw new Error('_handleMessage must be implemented by subclass');
  }

  // ------------------------------------------------------------------
  // Utility
  // ------------------------------------------------------------------

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Return whether the workspace has the Browser Fabric viewer toggle on.
   * Cached for the lifetime of the adapter — restart to pick up a flip.
   * Falls back to false on error so the prompt builders don't accidentally
   * inject the strong directive against an older backend that can't route
   * to Browser Fabric.
   */
  async getBrowserEnabled() {
    if (this._browserEnabledCache === null) {
      try {
        const meta = await this.client.getWorkspaceMetadata(this.workspaceId, this.token);
        this._browserEnabledCache = !!(meta && meta.browserEnabled);
      } catch (e) {
        this._browserEnabledCache = false;
      }
    }
    return this._browserEnabledCache;
  }

  async _buildRuntimeContextPrompt(channelName, currentEventId) {
    if (!this._sessionId) return '';
    try {
      const context = await this.client.getAgentContext(
        this.workspaceId,
        this.agentName,
        this.token,
        {
          channelName,
          sessionId: this._sessionId,
          currentEventId,
          recentLimit: 12,
          ambientLimit: 6,
        },
      );
      const { buildRuntimeContextPrompt } = require('./workspace-prompt');
      return buildRuntimeContextPrompt(context);
    } catch (e) {
      this._log(`Runtime context pack unavailable: ${e && e.message ? e.message : e}`);
      return '';
    }
  }

  _buildDeliveryPrompt(msg) {
    const kind = msg && msg._deliveryKind;
    if (kind === 'ambient') {
      return [
        'Delivery kind: ambient channel context.',
        'This normal channel message is visible to every agent in the channel. Read it and update your understanding.',
        'Ambient is passive: do not create/claim tasks, @mention, assign, or visibly coordinate unless named, already owning the task, or acting as channel lead.',
        'If no visible action is needed from you, return exactly: __no_response__',
      ].join('\n');
    }
    if (kind === 'attention') {
      const reason = msg && msg._attentionReason ? ` (${msg._attentionReason})` : '';
      return [
        `Delivery kind: attention${reason}. This message was routed to you for visible handling.`,
        'Treat routed/mentioned messages as at-least-once delivery: they may be delayed, retried, or already reflected in current task state.',
        'Before creating, claiming, updating, or completing work, reconcile against the current task board, todos, recent messages, and repository state.',
        'If the message is stale or already handled, acknowledge the current state concisely or return exactly: __no_response__; do not duplicate side effects.',
      ].join('\n');
    }
    return '';
  }

  _isNoResponseText(text) {
    return String(text || '').trim() === '__no_response__';
  }
}

// ------------------------------------------------------------------
// A2UI helpers
// ------------------------------------------------------------------

/**
 * Pull the first ```a2ui ... ``` fenced block out of LLM-produced content.
 * Returns the content with the block stripped, the parsed spec, and a
 * tool-call id derived from `spec.tool_call_id` (if present) or a new one.
 * If no block is present or parsing fails, returns the content unchanged
 * with null spec — the message still goes out as plain markdown.
 */
/**
 * Convert a workspace.tool_result event into a synthetic user-message
 * shape that the agent's _handleMessage can dispatch. The LLM sees this
 * as the next user turn — the content is a short, machine-readable line
 * the LLM can parse without ambiguity. The original spec it emitted is
 * already in the LLM's conversation history; the tool_call_id lets the
 * LLM correlate this back.
 */
function synthesizeToolResultMessage(event) {
  if (!event || !event.payload) return null;
  const p = event.payload;
  const actionId = p.action_id || '';
  const toolCallId = p.tool_call_id || '';
  let valueStr = '';
  if (p.value !== undefined && p.value !== null) {
    try { valueStr = JSON.stringify(p.value); } catch (_) { valueStr = String(p.value); }
  }
  const lines = [
    '[ui_action]',
    `action=${actionId}`,
    toolCallId ? `tool_call_id=${toolCallId}` : null,
    valueStr ? `value=${valueStr}` : null,
  ].filter(Boolean);
  const content = lines.join(' ');
  const target = event.target || '';
  return {
    messageId: event.id || '',
    sessionId: target.startsWith('channel/') ? target.replace('channel/', '') : target,
    senderType: 'human',
    senderName: 'user',
    content,
    mentions: [],
    messageType: 'chat',
    metadata: event.metadata || {},
  };
}

function extractA2UISpec(content) {
  if (!content || typeof content !== 'string') {
    return { cleanContent: content, spec: null, specToolCallId: null };
  }
  const match = content.match(/```a2ui\s*\n([\s\S]*?)\n```/);
  if (!match) return { cleanContent: content, spec: null, specToolCallId: null };

  let spec;
  try {
    spec = JSON.parse(match[1]);
  } catch (_) {
    return { cleanContent: content, spec: null, specToolCallId: null };
  }

  const specToolCallId = (spec && spec.tool_call_id) || `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  if (spec && spec.tool_call_id) delete spec.tool_call_id;

  const cleanContent = content.replace(match[0], '').trim();
  return { cleanContent, spec, specToolCallId };
}

module.exports = BaseAdapter;
module.exports.extractA2UISpec = extractA2UISpec;
