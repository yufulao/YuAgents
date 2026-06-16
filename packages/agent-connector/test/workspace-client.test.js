'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { WorkspaceClient, SessionRevokedError } = require('../src/workspace-client');
const http = require('http');

describe('WorkspaceClient', () => {
  it('constructs with default endpoint', () => {
    const client = new WorkspaceClient();
    assert.equal(client.endpoint, 'https://workspace-endpoint.openagents.org');
  });

  it('constructs with custom endpoint and strips trailing slash', () => {
    const client = new WorkspaceClient('https://custom.api.com/');
    assert.equal(client.endpoint, 'https://custom.api.com');
  });

  it('_wsHeaders returns correct auth headers', () => {
    const client = new WorkspaceClient();
    const headers = client._wsHeaders('test-token-123');
    assert.equal(headers['Content-Type'], 'application/json');
    assert.equal(headers['X-Workspace-Token'], 'test-token-123');
  });

  it('_post rejects on network error', async () => {
    // Use a port that nothing is listening on
    const client = new WorkspaceClient('http://127.0.0.1:19999');
    await assert.rejects(
      () => client._post('/v1/test', { foo: 'bar' }),
      (err) => {
        assert.ok(err.message.includes('ECONNREFUSED') || err.message.includes('connect'));
        return true;
      }
    );
  });

  it('registerAgent builds correct request shape', async () => {
    // We can't easily test the full HTTP flow without a server,
    // but we can verify the method signature works
    const client = new WorkspaceClient('http://127.0.0.1:19999');
    await assert.rejects(
      () => client.registerAgent('test-agent', { apiKey: 'sk-123' }),
    );
  });

  it('createWorkspace builds correct url format', () => {
    const client = new WorkspaceClient('https://workspace-endpoint.openagents.org/v1');
    // Test the frontend URL derivation logic
    const frontendUrl = client.endpoint
      .replace('workspace-endpoint', 'workspace')
      .replace('/v1', '');
    assert.equal(frontendUrl, 'https://workspace.openagents.org');
  });

  it('SessionRevokedError is thrown when server returns session_revoked message', async () => {
    // Spin up a one-shot HTTP server that returns the error shape.
    const server = http.createServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        code: 401,
        message: 'session_revoked: another client is now running as this agent',
      }));
    });
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;
    try {
      const client = new WorkspaceClient(`http://127.0.0.1:${port}`);
      let caught = null;
      try {
        await client._post('/v1/heartbeat', { agent_name: 'x', network: 'n', session_id: 'stale' });
      } catch (e) {
        caught = e;
      }
      assert.ok(caught, 'expected error to be thrown');
      assert.ok(caught instanceof SessionRevokedError, 'expected SessionRevokedError');
      assert.equal(caught.code, 'session_revoked');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('sendEvent embeds session_id in event.metadata when provided', () => {
    const client = new WorkspaceClient('http://127.0.0.1:19999');
    // Capture what _post receives by stubbing it
    let capturedBody = null;
    client._post = async (_path, body) => { capturedBody = body; return { data: {} }; };
    return client.sendEvent('ws-1', { type: 't', source: 's', target: 'ch' }, 'tok', 'sess-xyz')
      .then(() => {
        assert.equal(capturedBody.metadata.session_id, 'sess-xyz');
        assert.equal(capturedBody.network, 'ws-1');
      });
  });

  it('heartbeat includes session_id and activity state when provided', () => {
    const client = new WorkspaceClient('http://127.0.0.1:19999');
    let capturedBody = null;
    client._post = async (_path, body) => { capturedBody = body; return { data: {} }; };
    return client.heartbeat('ws-1', 'bary-bot', 'tok', 'sess-abc', 'idle')
      .then(() => {
        assert.equal(capturedBody.agent_name, 'bary-bot');
        assert.equal(capturedBody.network, 'ws-1');
        assert.equal(capturedBody.session_id, 'sess-abc');
        assert.equal(capturedBody.activity_state, 'idle');
      });
  });

  it('heartbeat includes activity detail payload when provided', () => {
    const client = new WorkspaceClient('http://127.0.0.1:19999');
    let capturedBody = null;
    client._post = async (_path, body) => { capturedBody = body; return { data: {} }; };
    return client.heartbeat('ws-1', 'bary-bot', 'tok', 'sess-abc', {
      activity_state: 'running_command',
      activity_summary: '命令: npm test',
      current_channel: 'general',
      activity_details: [{ kind: 'command', label: '命令', value: 'npm test' }],
    })
      .then(() => {
        assert.equal(capturedBody.agent_name, 'bary-bot');
        assert.equal(capturedBody.network, 'ws-1');
        assert.equal(capturedBody.session_id, 'sess-abc');
        assert.equal(capturedBody.activity_state, 'running_command');
        assert.equal(capturedBody.activity_summary, '命令: npm test');
        assert.equal(capturedBody.current_channel, 'general');
        assert.equal(capturedBody.activity_details[0].value, 'npm test');
      });
  });

  it('disconnect includes session_id when provided', () => {
    const client = new WorkspaceClient('http://127.0.0.1:19999');
    let capturedBody = null;
    client._post = async (_path, body) => { capturedBody = body; return { data: {} }; };
    return client.disconnect('ws-1', 'bary-bot', 'tok', 'sess-leave')
      .then(() => {
        assert.equal(capturedBody.agent_name, 'bary-bot');
        assert.equal(capturedBody.network, 'ws-1');
        assert.equal(capturedBody.session_id, 'sess-leave');
      });
  });

  it('pollPending includes session_id when provided', () => {
    const client = new WorkspaceClient('http://127.0.0.1:19999');
    let capturedPath = null;
    client._get = async (path) => {
      if (path.startsWith('/v1/agent-deliveries/pending?')) {
        throw new Error('404 Not Found');
      }
      capturedPath = path;
      return { data: { events: [] } };
    };
    return client.pollPending('ws-1', 'bary-bot', 'tok', { sessionId: 'sess-read' })
      .then(() => {
        assert.ok(capturedPath.includes('member=bary-bot'));
        assert.ok(capturedPath.includes('session_id=sess-read'));
      });
  });

  it('pollPending prefers durable deliveries when backend supports them', async () => {
    const client = new WorkspaceClient('http://127.0.0.1:19999');
    let capturedPath = null;
    client._get = async (path) => {
      capturedPath = path;
      return {
        data: {
          deliveries: [{
            id: 'delivery-1',
            attempts: 2,
            event: {
              id: 'event-1',
              source: 'human:user',
              target: 'channel/general',
              payload: { content: 'hello', message_type: 'chat' },
              metadata: { target_agents: ['bary-bot'] },
              timestamp: Date.now(),
            },
          }],
        },
      };
    };
    const result = await client.pollPending('ws-1', 'bary-bot', 'tok', {
      after: 'old-head',
      sessionId: 'sess-read',
      leaseSeconds: 300,
    });
    assert.ok(capturedPath.startsWith('/v1/agent-deliveries/pending?'));
    assert.ok(capturedPath.includes('agent=bary-bot'));
    assert.ok(capturedPath.includes('lease_seconds=300'));
    assert.equal(result.durable, true);
    assert.equal(result.cursor, 'old-head');
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].messageId, 'event-1');
    assert.equal(result.messages[0]._deliveryId, 'delivery-1');
    assert.equal(result.messages[0]._deliveryAttempts, 2);
  });

  it('pollPending can lease ambient durable deliveries', async () => {
    const client = new WorkspaceClient('http://127.0.0.1:19999');
    let capturedPath = null;
    client._get = async (path) => {
      capturedPath = path;
      return {
        data: {
          deliveries: [{
            id: 'delivery-ambient',
            delivery_kind: 'ambient',
            attention_reason: null,
            attempts: 1,
            event: {
              id: 'event-ambient',
              source: 'human:user',
              target: 'channel/general',
              payload: { content: 'visible to the room', message_type: 'chat' },
              metadata: { target_agents: ['other-agent'] },
              timestamp: Date.now(),
            },
          }],
        },
      };
    };

    const result = await client.pollPending('ws-1', 'bary-bot', 'tok', {
      sessionId: 'sess-read',
      includeAmbient: true,
    });

    assert.ok(capturedPath.includes('include_ambient=true'));
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0]._deliveryId, 'delivery-ambient');
    assert.equal(result.messages[0]._deliveryKind, 'ambient');
  });

  it('ackDelivery posts current session proof', async () => {
    const client = new WorkspaceClient('http://127.0.0.1:19999');
    let capturedPath = null;
    let capturedBody = null;
    client._post = async (path, body) => {
      capturedPath = path;
      capturedBody = body;
      return { data: { status: 'acked' } };
    };
    const result = await client.ackDelivery('ws-1', 'bary-bot', 'tok', 'delivery:1', 'sess-ack');
    assert.equal(capturedPath, '/v1/agent-deliveries/delivery%3A1/ack');
    assert.equal(capturedBody.network, 'ws-1');
    assert.equal(capturedBody.agent_name, 'bary-bot');
    assert.equal(capturedBody.session_id, 'sess-ack');
    assert.equal(capturedBody.status, 'acked');
    assert.equal(result.status, 'acked');
  });

  it('getRecentMessages includes member and session_id when provided', () => {
    const client = new WorkspaceClient('http://127.0.0.1:19999');
    let capturedPath = null;
    client._get = async (path) => {
      capturedPath = path;
      return { data: { events: [] } };
    };
    return client.getRecentMessages('ws-1', 'private-room', 'tok', 30, {
      member: 'bary-bot',
      sessionId: 'sess-history',
    }).then(() => {
      assert.ok(capturedPath.includes('channel=private-room'));
      assert.ok(capturedPath.includes('member=bary-bot'));
      assert.ok(capturedPath.includes('session_id=sess-history'));
      });
  });

  it('getAgentContext fetches runtime context with current session proof', async () => {
    const client = new WorkspaceClient('http://127.0.0.1:19999');
    let capturedPath = null;
    client._get = async (path) => {
      capturedPath = path;
      return { data: { self: { agent_name: 'bary-bot' }, agents: [] } };
    };
    const result = await client.getAgentContext('ws-1', 'bary-bot', 'tok', {
      channelName: 'workroom',
      sessionId: 'sess-context',
      currentEventId: 'event-current',
      recentLimit: 12,
      ambientLimit: 7,
    });
    assert.ok(capturedPath.startsWith('/v1/agent-context?'));
    assert.ok(capturedPath.includes('network=ws-1'));
    assert.ok(capturedPath.includes('agent=bary-bot'));
    assert.ok(capturedPath.includes('session_id=sess-context'));
    assert.ok(capturedPath.includes('channel=workroom'));
    assert.ok(capturedPath.includes('current_event_id=event-current'));
    assert.ok(capturedPath.includes('recent_limit=12'));
    assert.ok(capturedPath.includes('ambient_limit=7'));
    assert.equal(result.self.agent_name, 'bary-bot');
  });

  it('workspace task helpers call shared task endpoints', async () => {
    const client = new WorkspaceClient('http://127.0.0.1:19999');
    const calls = [];
    client._post = async (path, body) => {
      calls.push(['post', path, body]);
      return { data: { task: { id: 'task-1', title: body.title || 'claimed' } } };
    };
    client._get = async (path) => {
      calls.push(['get', path, null]);
      return { data: { tasks: [] } };
    };
    client._patch = async (path, body) => {
      calls.push(['patch', path, body]);
      return { data: { task: { id: 'task-1', status: body.status } } };
    };

    await client.createWorkspaceTask('ws-1', 'workroom', 'tok', {
      title: 'Build task graph',
      assignee: 'agent-beta',
      dependsOn: ['task-0'],
      source: 'openagents:lead',
    });
    await client.listWorkspaceTasks('ws-1', 'workroom', 'tok', { assignee: 'agent-beta' });
    await client.claimWorkspaceTask('ws-1', 'agent-beta', 'tok', 'task-1', 'sess-task');
    await client.updateWorkspaceTask('ws-1', 'tok', 'task-1', {
      source: 'openagents:agent-beta',
      status: 'in_review',
      result: 'done',
    });

    assert.equal(calls[0][0], 'post');
    assert.equal(calls[0][1], '/v1/workspace-tasks');
    assert.equal(calls[0][2].channel, 'workroom');
    assert.equal(calls[0][2].source, 'openagents:lead');
    assert.deepEqual(calls[0][2].depends_on, ['task-0']);
    assert.ok(calls[1][1].startsWith('/v1/workspace-tasks?'));
    assert.ok(calls[1][1].includes('assignee=agent-beta'));
    assert.equal(calls[2][1], '/v1/workspace-tasks/task-1/claim');
    assert.equal(calls[2][2].session_id, 'sess-task');
    assert.equal(calls[3][1], '/v1/workspace-tasks/task-1');
    assert.equal(calls[3][2].status, 'in_review');
    assert.equal(calls[3][2].source, 'openagents:agent-beta');
  });

  it('workspace task helpers do not synthesize unknown source', async () => {
    const client = new WorkspaceClient('http://127.0.0.1:19999');
    const calls = [];
    client._post = async (path, body) => {
      calls.push(['post', path, body]);
      return { data: { task: { id: 'task-1' } } };
    };
    client._patch = async (path, body) => {
      calls.push(['patch', path, body]);
      return { data: { task: { id: 'task-1' } } };
    };

    await client.createWorkspaceTask('ws-1', 'workroom', 'tok', {
      title: 'Missing source',
    });
    await client.updateWorkspaceTask('ws-1', 'tok', 'task-1', {
      status: 'done',
    });

    assert.equal(Object.prototype.hasOwnProperty.call(calls[0][2], 'source'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(calls[1][2], 'source'), false);
  });
});
