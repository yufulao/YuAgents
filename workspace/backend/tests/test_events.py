# -*- coding: utf-8 -*-
"""
Tests for the event-native API (POST/GET /v1/events).
"""

import pytest

from app.models import AgentDelivery, EventRecord


class TestSendEvent:
    """POST /v1/events — send events through the pipeline."""

    def test_send_message_event(self, client, workspace):
        """Send a workspace.message.posted event through the pipeline."""
        channel_name = workspace["channel"]["name"]
        resp = client.post("/v1/events", json={
            "type": "workspace.message.posted",
            "source": "human:user1",
            "target": f"channel/{channel_name}",
            "payload": {"content": "Hello, world!"},
            "network": workspace["id"],
        }, headers={"X-Workspace-Token": workspace["token"]})

        assert resp.status_code == 200
        data = resp.json()["data"]
        assert data["type"] == "workspace.message.posted"
        assert data["source"] == "human:user1"
        assert data["target"] == f"channel/{channel_name}"
        assert "id" in data
        assert "timestamp" in data

    def test_send_event_missing_network(self, client, workspace):
        """Events without network field are rejected."""
        resp = client.post("/v1/events", json={
            "type": "workspace.message.posted",
            "source": "human:user1",
            "target": "channel/test",
        })
        assert resp.status_code == 400

    def test_send_event_invalid_network(self, client, workspace):
        """Events with nonexistent network are rejected."""
        resp = client.post("/v1/events", json={
            "type": "workspace.message.posted",
            "source": "human:user1",
            "target": "channel/test",
            "network": "nonexistent",
        })
        assert resp.status_code == 404

    def test_send_event_wrong_token(self, client, workspace):
        """Events with wrong token are rejected by auth mod."""
        resp = client.post("/v1/events", json={
            "type": "workspace.message.posted",
            "source": "human:user1",
            "target": "channel/test",
            "network": workspace["id"],
        }, headers={"X-Workspace-Token": "wrong-token"})
        assert resp.status_code == 401

    def test_send_event_stamps_network_id(self, client, workspace):
        """Auth mod stamps network ID on the event."""
        channel_name = workspace["channel"]["name"]
        resp = client.post("/v1/events", json={
            "type": "workspace.message.posted",
            "source": "openagents:agent-alpha",
            "target": f"channel/{channel_name}",
            "payload": {"content": "test"},
            "network": workspace["id"],
        }, headers={"X-Workspace-Token": workspace["token"]})

        assert resp.status_code == 200

        # Verify event was persisted
        poll = client.get("/v1/events", params={"network": workspace["id"]},
                          headers={"X-Workspace-Token": workspace["token"]})
        assert poll.status_code == 200
        events = poll.json()["data"]["events"]
        assert len(events) >= 1
        found = [e for e in events if e["type"] == "workspace.message.posted"]
        assert len(found) >= 1

    def test_send_event_with_metadata(self, client, workspace):
        """Custom metadata is preserved through the pipeline."""
        channel_name = workspace["channel"]["name"]
        resp = client.post("/v1/events", json={
            "type": "workspace.message.posted",
            "source": "openagents:agent-alpha",
            "target": f"channel/{channel_name}",
            "payload": {"content": "test"},
            "metadata": {"custom_key": "custom_value"},
            "network": workspace["id"],
        }, headers={"X-Workspace-Token": workspace["token"]})

        assert resp.status_code == 200
        data = resp.json()["data"]
        assert data["metadata"]["custom_key"] == "custom_value"

    def test_direct_agent_control_still_allowed(self, client, workspace):
        """Direct visibility remains available for internal agent control events."""
        resp = client.post("/v1/events", json={
            "type": "workspace.agent.control",
            "source": "human:user1",
            "target": "openagents:agent-alpha",
            "payload": {"action": "stop"},
            "visibility": "direct",
            "network": workspace["id"],
        }, headers={"X-Workspace-Token": workspace["token"]})

        assert resp.status_code == 200
        data = resp.json()["data"]
        assert data["type"] == "workspace.agent.control"
        assert data["target"] == "openagents:agent-alpha"
        assert data["payload"]["action"] == "stop"

    def test_human_message_routes_to_master(self, client, workspace):
        """Human messages are routed to the channel master agent."""
        channel_name = workspace["channel"]["name"]
        resp = client.post("/v1/events", json={
            "type": "workspace.message.posted",
            "source": "human:user1",
            "target": f"channel/{channel_name}",
            "payload": {"content": "Hello agent!"},
            "network": workspace["id"],
        }, headers={"X-Workspace-Token": workspace["token"]})

        assert resp.status_code == 200
        data = resp.json()["data"]
        # workspace_mod should add target_agents with the channel master
        assert "target_agents" in data["metadata"]
        assert "agent-alpha" in data["metadata"]["target_agents"]


    def test_agent_message_master_no_targeting_in_single_agent_channel(self, client, workspace):
        """Master agent messages in single-agent channels have empty target_agents.

        With the LLM router, multi-agent routing uses the router.
        In single-agent channels (or when router is disabled), the fallback
        applies: master's own messages get no targeting.

        As of the routing fix: target_agents is ALWAYS set (to an empty
        list if nobody should respond) so clients don't fall through to
        broadcast-to-all on missing field.
        """
        channel_name = workspace["channel"]["name"]
        resp = client.post("/v1/events", json={
            "type": "workspace.message.posted",
            "source": "openagents:agent-alpha",
            "target": f"channel/{channel_name}",
            "payload": {
                "content": "@agent-beta please review the code",
                "message_type": "chat",
            },
            "network": workspace["id"],
        }, headers={"X-Workspace-Token": workspace["token"]})

        assert resp.status_code == 200
        data = resp.json()["data"]
        # Master's message in a single-agent channel — no real targets
        # (sentinel list, not missing, so legacy clients don't broadcast)
        assert data["metadata"].get("target_agents") == ["__no_response__"]

    def test_master_message_without_mentions_no_target_agents(self, client, workspace):
        """Master agent messages without mentions produce empty target_agents (no self-trigger)."""
        channel_name = workspace["channel"]["name"]
        resp = client.post("/v1/events", json={
            "type": "workspace.message.posted",
            "source": "openagents:agent-alpha",  # agent-alpha is the channel master
            "target": f"channel/{channel_name}",
            "payload": {"content": "Just a status update"},
            "network": workspace["id"],
        }, headers={"X-Workspace-Token": workspace["token"]})

        assert resp.status_code == 200
        data = resp.json()["data"]
        # Master's own messages should NOT trigger itself — sentinel
        # list (not missing field, not empty) so legacy clients skip.
        assert data["metadata"].get("target_agents") == ["__no_response__"]

    def test_member_message_without_mentions_routes_to_master(self, client, workspace):
        """Member agent messages without mentions route back to channel master."""
        # Add a member agent
        client.post("/v1/join", json={
            "agent_name": "agent-beta",
            "token": workspace["token"],
            "network": workspace["id"],
        })

        channel_name = workspace["channel"]["name"]
        resp = client.post("/v1/events", json={
            "type": "workspace.message.posted",
            "source": "openagents:agent-beta",  # member, not master
            "target": f"channel/{channel_name}",
            "payload": {"content": "I finished the task."},
            "network": workspace["id"],
        }, headers={"X-Workspace-Token": workspace["token"]})

        assert resp.status_code == 200
        data = resp.json()["data"]
        # Member's response should be routed back to the master
        assert data["metadata"]["target_agents"] == ["agent-alpha"]

    def test_member_message_with_mention_routes_to_mentioned_agent(self, client, workspace):
        """Agent messages with explicit @mentions route to the mentioned agent."""
        # Add member agents to workspace, then add the mentioned agent to the
        # channel. Mentions must not implicitly wake non-channel members.
        for name in ["agent-beta", "agent-gamma"]:
            client.post("/v1/join", json={
                "agent_name": name,
                "token": workspace["token"],
                "network": workspace["id"],
            })

        channel_name = workspace["channel"]["name"]
        join = client.post("/v1/events", json={
            "type": "network.channel.join",
            "source": "human:user1",
            "target": f"channel/{channel_name}",
            "payload": {"channel": channel_name, "agent_name": "agent-gamma"},
            "network": workspace["id"],
        }, headers={"X-Workspace-Token": workspace["token"]})
        assert join.status_code == 200

        resp = client.post("/v1/events", json={
            "type": "workspace.message.posted",
            "source": "openagents:agent-beta",
            "target": f"channel/{channel_name}",
            "payload": {"content": "@agent-gamma can you review this?"},
            "network": workspace["id"],
        }, headers={"X-Workspace-Token": workspace["token"]})

        assert resp.status_code == 200
        data = resp.json()["data"]
        # Explicit @mention routes directly to the mentioned agent
        assert data["metadata"]["target_agents"] == ["agent-gamma"]


class TestPollEvents:
    """GET /v1/events — poll events from a network."""

    def test_poll_empty_network(self, client, workspace):
        """Polling a new network returns empty list."""
        resp = client.get("/v1/events", params={"network": workspace["id"]},
                          headers={"X-Workspace-Token": workspace["token"]})
        assert resp.status_code == 200
        data = resp.json()["data"]
        assert data["events"] == []
        assert data["has_more"] is False

    def test_poll_after_send(self, client, workspace):
        """Events appear after being sent."""
        channel_name = workspace["channel"]["name"]
        # Send an event
        client.post("/v1/events", json={
            "type": "workspace.message.posted",
            "source": "openagents:agent-alpha",
            "target": f"channel/{channel_name}",
            "payload": {"content": "msg1"},
            "network": workspace["id"],
        }, headers={"X-Workspace-Token": workspace["token"]})

        # Poll
        resp = client.get("/v1/events", params={"network": workspace["id"]},
                          headers={"X-Workspace-Token": workspace["token"]})
        assert resp.status_code == 200
        events = resp.json()["data"]["events"]
        assert len(events) == 1
        assert events[0]["payload"]["content"] == "msg1"

    def test_poll_filter_by_type(self, client, workspace):
        """Filter events by type prefix."""
        channel_name = workspace["channel"]["name"]
        # Send two different event types
        for etype in ("workspace.message.posted", "workspace.session.created"):
            client.post("/v1/events", json={
                "type": etype,
                "source": "openagents:agent-alpha",
                "target": f"channel/{channel_name}",
                "payload": {},
                "network": workspace["id"],
            }, headers={"X-Workspace-Token": workspace["token"]})

        # Filter by workspace.session
        resp = client.get("/v1/events", params={
            "network": workspace["id"],
            "type": "workspace.session",
        }, headers={"X-Workspace-Token": workspace["token"]})
        events = resp.json()["data"]["events"]
        assert len(events) == 1
        assert events[0]["type"] == "workspace.session.created"

    def test_poll_filter_by_target(self, client, workspace):
        """Filter events by target address."""
        channel_name = workspace["channel"]["name"]
        client.post("/v1/events", json={
            "type": "workspace.message.posted",
            "source": "openagents:agent-alpha",
            "target": f"channel/{channel_name}",
            "payload": {},
            "network": workspace["id"],
        }, headers={"X-Workspace-Token": workspace["token"]})

        # Filter by exact target
        resp = client.get("/v1/events", params={
            "network": workspace["id"],
            "target": f"channel/{channel_name}",
        }, headers={"X-Workspace-Token": workspace["token"]})
        events = resp.json()["data"]["events"]
        assert len(events) == 1

        # Different target returns empty
        resp2 = client.get("/v1/events", params={
            "network": workspace["id"],
            "target": "channel/nonexistent",
        }, headers={"X-Workspace-Token": workspace["token"]})
        assert resp2.json()["data"]["events"] == []

    def test_poll_cursor_pagination(self, client, workspace):
        """Cursor-based pagination with after parameter."""
        channel_name = workspace["channel"]["name"]
        # Send 3 events
        event_ids = []
        for i in range(3):
            resp = client.post("/v1/events", json={
                "type": "workspace.message.posted",
                "source": "openagents:agent-alpha",
                "target": f"channel/{channel_name}",
                "payload": {"content": f"msg{i}"},
                "network": workspace["id"],
            }, headers={"X-Workspace-Token": workspace["token"]})
            event_ids.append(resp.json()["data"]["id"])

        # Get first page (limit 2)
        resp = client.get("/v1/events", params={
            "network": workspace["id"],
            "limit": 2,
        }, headers={"X-Workspace-Token": workspace["token"]})
        data = resp.json()["data"]
        assert len(data["events"]) == 2
        assert data["has_more"] is True

        # Get second page using cursor
        resp2 = client.get("/v1/events", params={
            "network": workspace["id"],
            "after": data["events"][1]["id"],
        }, headers={"X-Workspace-Token": workspace["token"]})
        data2 = resp2.json()["data"]
        assert len(data2["events"]) == 1
        assert data2["has_more"] is False

    def test_poll_invalid_network(self, client):
        """Polling nonexistent network returns 404."""
        resp = client.get("/v1/events", params={"network": "nonexistent"})
        assert resp.status_code == 404

    def test_conversations_endpoint_removed(self, client, workspace):
        """DM conversation discovery is no longer exposed."""
        resp = client.get("/v1/events/conversations", params={"network": workspace["id"]},
                          headers={"X-Workspace-Token": workspace["token"]})
        assert resp.status_code == 404


class TestAgentDeliveries:
    """Durable per-agent delivery inbox."""

    def test_direct_message_is_rejected_without_delivery(self, client, workspace, db):
        join = client.post("/v1/join", json={
            "agent_name": "agent-alpha",
            "token": workspace["token"],
            "network": workspace["id"],
        })
        assert join.status_code == 200

        before_count = db.query(AgentDelivery).count()

        sent = client.post("/v1/events", json={
            "type": "workspace.message.posted",
            "source": "human:user1",
            "target": "openagents:agent-alpha",
            "payload": {"content": "private hello"},
            "visibility": "direct",
            "network": workspace["id"],
        }, headers={"X-Workspace-Token": workspace["token"]})
        assert sent.status_code == 400
        assert "Direct chat is disabled" in sent.json()["message"]

        db.expire_all()
        assert db.query(AgentDelivery).count() == before_count

    def test_legacy_direct_message_delivery_is_not_leaseable(self, client, workspace, db):
        join = client.post("/v1/join", json={
            "agent_name": "agent-alpha",
            "token": workspace["token"],
            "network": workspace["id"],
        })
        assert join.status_code == 200
        session_id = join.json()["data"]["session_id"]

        event = EventRecord(
            id="legacy-direct-message",
            network_id=workspace["id"],
            type="workspace.message.posted",
            source="human:user1",
            target="openagents:agent-alpha",
            payload={"content": "old private hello"},
            metadata_={},
            timestamp=1,
            visibility="direct",
        )
        delivery = AgentDelivery(
            event_id=event.id,
            workspace_id=workspace["id"],
            agent_name="agent-alpha",
            delivery_kind="attention",
            attention_reason="direct",
            status="pending",
        )
        db.add(event)
        db.commit()

        db.add(delivery)
        db.commit()

        leased = client.get("/v1/agent-deliveries/pending", params={
            "network": workspace["id"],
            "agent": "agent-alpha",
            "session_id": session_id,
        }, headers={"X-Workspace-Token": workspace["token"]})

        assert leased.status_code == 200
        assert leased.json()["data"]["deliveries"] == []

    def test_targeted_message_creates_leaseable_delivery(self, client, workspace, db):
        join = client.post("/v1/join", json={
            "agent_name": "agent-alpha",
            "token": workspace["token"],
            "network": workspace["id"],
        })
        assert join.status_code == 200
        session_id = join.json()["data"]["session_id"]

        channel_name = workspace["channel"]["name"]
        sent = client.post("/v1/events", json={
            "type": "workspace.message.posted",
            "source": "human:user1",
            "target": f"channel/{channel_name}",
            "payload": {"content": "please handle this"},
            "network": workspace["id"],
        }, headers={"X-Workspace-Token": workspace["token"]})
        assert sent.status_code == 200
        event_id = sent.json()["data"]["id"]

        db.expire_all()
        delivery = db.query(AgentDelivery).filter_by(
            event_id=event_id,
            agent_name="agent-alpha",
        ).one()
        assert delivery.status == "pending"
        assert delivery.delivery_kind == "attention"
        assert delivery.attention_reason == "routed"

        leased = client.get("/v1/agent-deliveries/pending", params={
            "network": workspace["id"],
            "agent": "agent-alpha",
            "session_id": session_id,
        }, headers={"X-Workspace-Token": workspace["token"]})
        assert leased.status_code == 200
        deliveries = leased.json()["data"]["deliveries"]
        assert len(deliveries) == 1
        assert deliveries[0]["id"] == delivery.id
        assert deliveries[0]["event"]["id"] == event_id
        assert deliveries[0]["event"]["payload"]["content"] == "please handle this"
        assert deliveries[0]["attempts"] == 1

        ack = client.post(f"/v1/agent-deliveries/{delivery.id}/ack", json={
            "network": workspace["id"],
            "agent_name": "agent-alpha",
            "session_id": session_id,
        }, headers={"X-Workspace-Token": workspace["token"]})
        assert ack.status_code == 200
        assert ack.json()["data"]["status"] == "acked"

        again = client.get("/v1/agent-deliveries/pending", params={
            "network": workspace["id"],
            "agent": "agent-alpha",
            "session_id": session_id,
        }, headers={"X-Workspace-Token": workspace["token"]})
        assert again.status_code == 200
        assert again.json()["data"]["deliveries"] == []

    def test_delivery_requires_current_session(self, client, workspace):
        resp = client.get("/v1/agent-deliveries/pending", params={
            "network": workspace["id"],
            "agent": "agent-alpha",
            "session_id": "stale",
        }, headers={"X-Workspace-Token": workspace["token"]})
        assert resp.status_code == 401

    def test_channel_message_creates_ambient_delivery_for_non_target_participants(self, client, workspace, db):
        alpha_join = client.post("/v1/join", json={
            "agent_name": "agent-alpha",
            "token": workspace["token"],
            "network": workspace["id"],
        })
        beta_join = client.post("/v1/join", json={
            "agent_name": "agent-beta",
            "token": workspace["token"],
            "network": workspace["id"],
        })
        assert alpha_join.status_code == 200
        assert beta_join.status_code == 200
        beta_session = beta_join.json()["data"]["session_id"]

        channel_name = workspace["channel"]["name"]
        join_channel = client.post("/v1/events", json={
            "type": "network.channel.join",
            "source": "human:user1",
            "target": f"channel/{channel_name}",
            "payload": {"channel": channel_name, "agent_name": "agent-beta"},
            "network": workspace["id"],
        }, headers={"X-Workspace-Token": workspace["token"]})
        assert join_channel.status_code == 200

        sent = client.post("/v1/events", json={
            "type": "workspace.message.posted",
            "source": "human:user1",
            "target": f"channel/{channel_name}",
            "payload": {"content": "normal channel message"},
            "network": workspace["id"],
        }, headers={"X-Workspace-Token": workspace["token"]})
        assert sent.status_code == 200
        event_id = sent.json()["data"]["id"]

        db.expire_all()
        deliveries = db.query(AgentDelivery).filter_by(event_id=event_id).all()
        by_agent = {d.agent_name: d for d in deliveries}
        assert by_agent["agent-alpha"].delivery_kind == "attention"
        assert by_agent["agent-beta"].delivery_kind == "ambient"
        assert by_agent["agent-beta"].attention_reason is None

        default_poll = client.get("/v1/agent-deliveries/pending", params={
            "network": workspace["id"],
            "agent": "agent-beta",
            "session_id": beta_session,
        }, headers={"X-Workspace-Token": workspace["token"]})
        assert default_poll.status_code == 200
        assert default_poll.json()["data"]["deliveries"] == []

        ambient_poll = client.get("/v1/agent-deliveries/pending", params={
            "network": workspace["id"],
            "agent": "agent-beta",
            "session_id": beta_session,
            "include_ambient": True,
        }, headers={"X-Workspace-Token": workspace["token"]})
        assert ambient_poll.status_code == 200
        ambient_deliveries = ambient_poll.json()["data"]["deliveries"]
        assert len(ambient_deliveries) == 1
        assert ambient_deliveries[0]["delivery_kind"] == "ambient"
        assert ambient_deliveries[0]["event"]["id"] == event_id

    def test_agent_context_pack_includes_roles_recent_and_unleased_ambient(self, client, workspace, db):
        alpha_join = client.post("/v1/join", json={
            "agent_name": "agent-alpha",
            "token": workspace["token"],
            "network": workspace["id"],
        })
        beta_join = client.post("/v1/join", json={
            "agent_name": "agent-beta",
            "token": workspace["token"],
            "network": workspace["id"],
        })
        assert alpha_join.status_code == 200
        assert beta_join.status_code == 200
        beta_session = beta_join.json()["data"]["session_id"]

        # Give beta a role description so the context pack can preserve role
        # boundaries instead of making every agent look interchangeable.
        patch = client.patch(
            f"/v1/workspaces/{workspace['id']}/members/agent-beta",
            json={"role": "qa", "description": "QA agent: reproduce bugs and verify fixes."},
            headers={"X-Workspace-Token": workspace["token"]},
        )
        assert patch.status_code == 200

        channel_name = workspace["channel"]["name"]
        join_channel = client.post("/v1/events", json={
            "type": "network.channel.join",
            "source": "human:user1",
            "target": f"channel/{channel_name}",
            "payload": {"channel": channel_name, "agent_name": "agent-beta"},
            "network": workspace["id"],
        }, headers={"X-Workspace-Token": workspace["token"]})
        assert join_channel.status_code == 200

        sent = client.post("/v1/events", json={
            "type": "workspace.message.posted",
            "source": "human:user1",
            "target": f"channel/{channel_name}",
            "payload": {"content": "please handle and keep beta in context", "message_type": "chat"},
            "network": workspace["id"],
        }, headers={"X-Workspace-Token": workspace["token"]})
        assert sent.status_code == 200
        event_id = sent.json()["data"]["id"]

        db.expire_all()
        beta_delivery = db.query(AgentDelivery).filter_by(
            event_id=event_id,
            agent_name="agent-beta",
        ).one()
        assert beta_delivery.delivery_kind == "ambient"
        assert beta_delivery.status == "pending"

        context = client.get("/v1/agent-context", params={
            "network": workspace["id"],
            "agent": "agent-beta",
            "session_id": beta_session,
            "channel": channel_name,
        }, headers={"X-Workspace-Token": workspace["token"]})
        assert context.status_code == 200
        data = context.json()["data"]
        assert data["self"]["agent_name"] == "agent-beta"
        assert data["self"]["role"] == "qa"
        assert "verify fixes" in data["self"]["description"]
        assert any(a["agent_name"] == "agent-alpha" and a["role"] == "master" for a in data["agents"])
        assert any(m["id"] == event_id for m in data["recent_messages"])
        assert len(data["ambient_messages"]) == 1
        assert data["ambient_messages"][0]["id"] == beta_delivery.id
        assert data["ambient_messages"][0]["event"]["id"] == event_id
        assert any("role" in rule.lower() for rule in data["runtime_rules"])

        db.expire_all()
        unchanged = db.query(AgentDelivery).filter_by(id=beta_delivery.id).one()
        assert unchanged.status == "pending"
        assert unchanged.lease_owner_session_id is None

    def test_agent_context_pack_compacts_process_messages_without_changing_event_log(self, client, workspace):
        alpha_join = client.post("/v1/join", json={
            "agent_name": "agent-alpha",
            "token": workspace["token"],
            "network": workspace["id"],
        })
        assert alpha_join.status_code == 200
        alpha_session = alpha_join.json()["data"]["session_id"]
        channel_name = workspace["channel"]["name"]

        long_thinking = "reasoning-step " * 80
        long_detail = {"tool_call": "expensive-output " * 80}
        sent = client.post("/v1/events", json={
            "type": "workspace.message.posted",
            "source": "openagents:agent-alpha",
            "target": f"channel/{channel_name}",
            "payload": {
                "content": long_thinking,
                "message_type": "thinking",
                "details": long_detail,
            },
            "network": workspace["id"],
        }, headers={"X-Workspace-Token": workspace["token"]})
        assert sent.status_code == 200
        thinking_id = sent.json()["data"]["id"]

        todos = client.post("/v1/events", json={
            "type": "workspace.message.posted",
            "source": "openagents:agent-alpha",
            "target": f"channel/{channel_name}",
            "payload": {
                "content": "full personal todo list",
                "message_type": "todos",
                "todos": [
                    {"content": "inspect", "status": "completed"},
                    {"content": "patch", "status": "in_progress"},
                    {"content": "verify", "status": "pending"},
                ],
            },
            "network": workspace["id"],
        }, headers={"X-Workspace-Token": workspace["token"]})
        assert todos.status_code == 200
        todos_id = todos.json()["data"]["id"]

        context = client.get("/v1/agent-context", params={
            "network": workspace["id"],
            "agent": "agent-alpha",
            "session_id": alpha_session,
            "channel": channel_name,
        }, headers={"X-Workspace-Token": workspace["token"]})
        assert context.status_code == 200
        messages = {m["id"]: m for m in context.json()["data"]["recent_messages"]}

        thinking_payload = messages[thinking_id]["payload"]
        assert thinking_payload["message_type"] == "thinking"
        assert thinking_payload["context_compacted"] is True
        assert len(thinking_payload["content"]) <= 160
        assert "expensive-output" not in str(thinking_payload)
        assert "details" not in thinking_payload

        todos_payload = messages[todos_id]["payload"]
        assert todos_payload["message_type"] == "todos"
        assert todos_payload["context_compacted"] is True
        assert todos_payload["content"] == "todos: 1 pending, 1 in_progress, 1 completed"
        assert "todos" not in todos_payload

        poll = client.get("/v1/events", params={"network": workspace["id"]},
                          headers={"X-Workspace-Token": workspace["token"]})
        assert poll.status_code == 200
        events = {e["id"]: e for e in poll.json()["data"]["events"]}
        assert events[thinking_id]["payload"]["details"] == long_detail
        assert events[todos_id]["payload"]["todos"][0]["content"] == "inspect"

    def test_agent_context_pack_requires_current_session(self, client, workspace):
        resp = client.get("/v1/agent-context", params={
            "network": workspace["id"],
            "agent": "agent-alpha",
            "session_id": "stale",
            "channel": workspace["channel"]["name"],
        }, headers={"X-Workspace-Token": workspace["token"]})
        assert resp.status_code == 401
