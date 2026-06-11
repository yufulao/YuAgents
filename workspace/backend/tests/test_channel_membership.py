# -*- coding: utf-8 -*-
"""
Tests for channel.join / channel.leave authorization + routine-channel lock.
"""

from unittest.mock import patch

from sqlalchemy import select

from app.models import Channel, ChannelHumanMember, ChannelMember, WorkspaceMember


def _headers(workspace, *, bearer: bool = False):
    headers = {"X-Workspace-Token": workspace["token"]}
    if bearer:
        headers["Authorization"] = "Bearer test-token"
    return headers


def _post_event(client, workspace, *, etype, source, channel, agent_name):
    return client.post(
        "/v1/events",
        json={
            "type": etype,
            "source": source,
            "target": f"channel/{channel}",
            "network": workspace["id"],
            "payload": {"channel": channel, "agent_name": agent_name},
        },
        headers=_headers(workspace),
    )


def _post_message(client, workspace, *, source, channel, content, sender_email=None, headers=None):
    payload = {
        "content": content,
        "message_type": "chat",
        "sender_type": "agent" if source.startswith("openagents:") else "human",
        "sender_name": source.split(":", 1)[1],
    }
    if sender_email:
        payload["sender_email"] = sender_email
    return client.post(
        "/v1/events",
        json={
            "type": "workspace.message.posted",
            "source": source,
            "target": f"channel/{channel}",
            "network": workspace["id"],
            "payload": payload,
        },
        headers=headers or _headers(workspace),
    )


def _post_authorized_human_message(client, workspace, *, channel, content, email="user@example.com"):
    with patch("app.firebase_auth.verify_firebase_token", return_value=email):
        return _post_message(
            client,
            workspace,
            source="human:user",
            channel=channel,
            content=content,
            sender_email=email,
            headers=_headers(workspace, bearer=True),
        )


def _set_channel_private(db, workspace):
    channel_name = workspace["channel"]["name"]
    channel = db.execute(
        select(Channel).where(
            Channel.workspace_id == workspace["id"],
            Channel.name == channel_name,
        )
    ).scalar_one()
    channel.visibility = "private"
    channel.mention_policy = "members_only"
    db.commit()
    return channel


def _add_workspace_member(db, workspace, agent_name, session_id=None):
    existing = db.execute(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == workspace["id"],
            WorkspaceMember.agent_name == agent_name,
        )
    ).scalar_one_or_none()
    if existing:
        if session_id:
            existing.session_id = session_id
            db.commit()
        return
    if not existing:
        db.add(WorkspaceMember(
            workspace_id=workspace["id"],
            agent_name=agent_name,
            role="member",
            agent_type="test",
            status="online",
            session_id=session_id,
        ))
        db.commit()


def _is_channel_member(db, channel, agent_name):
    return db.execute(
        select(ChannelMember).where(
            ChannelMember.channel_id == channel.id,
            ChannelMember.agent_name == agent_name,
        )
    ).scalar_one_or_none() is not None


def _add_human_channel_member(db, channel, email="user@example.com"):
    db.add(ChannelHumanMember(channel_id=channel.id, user_email=email))
    db.commit()
    return email


def _set_agent_session(db, workspace, agent_name="agent-alpha", session_id="sess-alpha"):
    _add_workspace_member(db, workspace, agent_name, session_id=session_id)
    return session_id


class TestChannelJoinAuth:
    def test_human_can_invite(self, client, workspace):
        channel = workspace["channel"]["name"]
        resp = _post_event(
            client, workspace,
            etype="network.channel.join",
            source="human:user",
            channel=channel,
            agent_name="agent-alpha",
        )
        assert resp.status_code == 200, resp.text

    def test_unrelated_agent_cannot_invite(self, client, workspace):
        """Random openagents source can't add an agent to a channel they don't own."""
        channel = workspace["channel"]["name"]
        resp = _post_event(
            client, workspace,
            etype="network.channel.join",
            source="openagents:random-bystander",
            channel=channel,
            agent_name="agent-alpha",
        )
        assert resp.status_code == 403, resp.text
        assert "forbidden" in resp.json()["message"].lower()

    def test_agent_can_join_self(self, client, workspace):
        """An agent can join a channel as itself (the agent_name in payload)."""
        channel = workspace["channel"]["name"]
        resp = _post_event(
            client, workspace,
            etype="network.channel.join",
            source="openagents:agent-beta",
            channel=channel,
            agent_name="agent-beta",
        )
        assert resp.status_code == 200, resp.text

    def test_join_routine_channel_rejected(self, client, workspace):
        """routines:* channels are locked — even humans can't add agents."""
        resp = _post_event(
            client, workspace,
            etype="network.channel.join",
            source="human:user",
            channel="routines:agent-alpha",
            agent_name="some-other-agent",
        )
        assert resp.status_code == 403, resp.text
        assert "routine_channel_locked" in resp.json()["message"]


class TestChannelLeaveAuth:
    def test_human_can_remove(self, client, workspace):
        channel = workspace["channel"]["name"]
        resp = _post_event(
            client, workspace,
            etype="network.channel.leave",
            source="human:user",
            channel=channel,
            agent_name="agent-alpha",
        )
        assert resp.status_code == 200, resp.text

    def test_unrelated_agent_cannot_remove(self, client, workspace):
        channel = workspace["channel"]["name"]
        resp = _post_event(
            client, workspace,
            etype="network.channel.leave",
            source="openagents:random-bystander",
            channel=channel,
            agent_name="agent-alpha",
        )
        assert resp.status_code == 403, resp.text

    def test_agent_can_remove_self(self, client, workspace):
        channel = workspace["channel"]["name"]
        resp = _post_event(
            client, workspace,
            etype="network.channel.leave",
            source="openagents:agent-alpha",
            channel=channel,
            agent_name="agent-alpha",
        )
        assert resp.status_code == 200, resp.text

    def test_leave_routine_channel_rejected(self, client, workspace):
        resp = _post_event(
            client, workspace,
            etype="network.channel.leave",
            source="human:user",
            channel="routines:agent-alpha",
            agent_name="agent-alpha",
        )
        assert resp.status_code == 403, resp.text
        assert "routine_channel_locked" in resp.json()["message"]


class TestPrivateChannelPermissions:
    def test_private_channel_mention_does_not_auto_add_non_member(self, client, db, workspace):
        channel = _set_channel_private(db, workspace)
        email = _add_human_channel_member(db, channel)
        _add_workspace_member(db, workspace, "agent-beta")

        resp = _post_authorized_human_message(
            client, workspace,
            channel=channel.name,
            content="@agent-beta please respond",
            email=email,
        )

        assert resp.status_code == 200, resp.text
        metadata = resp.json()["data"]["metadata"]
        assert "agent-beta" not in metadata["target_agents"]
        assert not _is_channel_member(db, channel, "agent-beta")

    def test_private_channel_discover_without_member_hides_channel(self, client, db, workspace):
        channel = _set_channel_private(db, workspace)

        resp = client.get(
            "/v1/discover",
            params={"network": workspace["id"]},
            headers=_headers(workspace),
        )

        assert resp.status_code == 200, resp.text
        channel_names = [c["address"].replace("channel/", "", 1) for c in resp.json()["data"]["channels"]]
        assert channel.name not in channel_names

    def test_private_channel_poll_without_member_scope_hides_channel_events(self, client, db, workspace):
        channel = _set_channel_private(db, workspace)
        email = _add_human_channel_member(db, channel)
        posted = _post_authorized_human_message(
            client, workspace,
            channel=channel.name,
            content="private message",
            email=email,
        )
        assert posted.status_code == 200, posted.text

        resp = client.get(
            "/v1/events",
            params={
                "network": workspace["id"],
                "channel": channel.name,
                "type": "workspace.message.posted",
            },
            headers=_headers(workspace),
        )

        assert resp.status_code == 200, resp.text
        assert resp.json()["data"]["events"] == []

    def test_private_channel_latest_per_channel_hides_preview_without_member(self, client, db, workspace):
        channel = _set_channel_private(db, workspace)
        email = _add_human_channel_member(db, channel)
        posted = _post_authorized_human_message(
            client, workspace,
            channel=channel.name,
            content="private preview",
            email=email,
        )
        assert posted.status_code == 200, posted.text

        resp = client.get(
            "/v1/events/latest-per-channel",
            params={"network": workspace["id"]},
            headers=_headers(workspace),
        )

        assert resp.status_code == 200, resp.text
        assert channel.name not in resp.json()["data"]["channels"]

    def test_private_channel_stream_rejects_unscoped_channel_subscribe(self, client, db, workspace):
        channel = _set_channel_private(db, workspace)

        resp = client.get(
            "/v1/events/stream",
            params={"network": workspace["id"], "channel": channel.name},
            headers=_headers(workspace),
        )

        assert resp.status_code == 403, resp.text
        assert "private_channel_read_forbidden" in resp.json()["message"]

    def test_private_channel_member_scope_requires_session_for_closed_reads(self, client, db, workspace):
        channel = _set_channel_private(db, workspace)
        session_id = _set_agent_session(db, workspace, "agent-alpha", "sess-alpha")
        email = _add_human_channel_member(db, channel)
        posted = _post_authorized_human_message(
            client, workspace,
            channel=channel.name,
            content="private session-bound message",
            email=email,
        )
        assert posted.status_code == 200, posted.text

        discover = client.get(
            "/v1/discover",
            params={"network": workspace["id"], "member": "agent-alpha"},
            headers=_headers(workspace),
        )
        assert discover.status_code == 200, discover.text
        channel_names = [c["address"].replace("channel/", "", 1) for c in discover.json()["data"]["channels"]]
        assert channel.name not in channel_names

        events = client.get(
            "/v1/events",
            params={
                "network": workspace["id"],
                "member": "agent-alpha",
                "channel": channel.name,
                "type": "workspace.message.posted",
            },
            headers=_headers(workspace),
        )
        assert events.status_code == 200, events.text
        assert events.json()["data"]["events"] == []

        latest = client.get(
            "/v1/events/latest-per-channel",
            params={"network": workspace["id"], "member": "agent-alpha"},
            headers=_headers(workspace),
        )
        assert latest.status_code == 200, latest.text
        assert channel.name not in latest.json()["data"]["channels"]

        stream = client.get(
            "/v1/events/stream",
            params={"network": workspace["id"], "member": "agent-alpha", "channel": channel.name},
            headers=_headers(workspace),
        )
        assert stream.status_code == 403, stream.text
        assert "private_channel_read_forbidden" in stream.json()["message"]

        authorized = client.get(
            "/v1/events",
            params={
                "network": workspace["id"],
                "member": "agent-alpha",
                "session_id": session_id,
                "channel": channel.name,
                "type": "workspace.message.posted",
            },
            headers=_headers(workspace),
        )
        assert authorized.status_code == 200, authorized.text
        assert [e["payload"]["content"] for e in authorized.json()["data"]["events"]] == [
            "private session-bound message"
        ]

    def test_private_channel_rejects_post_from_non_member_human(self, client, db, workspace):
        channel = _set_channel_private(db, workspace)

        resp = _post_message(
            client, workspace,
            source="human:user",
            channel=channel.name,
            content="I should not be able to post here",
            sender_email="outsider@example.com",
        )

        assert resp.status_code == 403, resp.text
        assert "private_channel_post_forbidden" in resp.json()["message"]
        existing = db.execute(
            select(ChannelHumanMember).where(
                ChannelHumanMember.channel_id == channel.id,
                ChannelHumanMember.user_email == "outsider@example.com",
            )
        ).scalar_one_or_none()
        assert existing is None

    def test_private_channel_rejects_human_post_with_spoofed_payload_email(self, client, db, workspace):
        channel = _set_channel_private(db, workspace)
        member_email = _add_human_channel_member(db, channel, "member@example.com")

        resp = _post_message(
            client, workspace,
            source="human:user",
            channel=channel.name,
            content="payload email should not authorize this",
            sender_email=member_email,
        )

        assert resp.status_code == 403, resp.text
        assert "private_channel_post_forbidden" in resp.json()["message"]

    def test_private_channel_rejects_post_from_non_member_agent(self, client, db, workspace):
        channel = _set_channel_private(db, workspace)
        _add_workspace_member(db, workspace, "agent-beta")

        resp = _post_message(
            client, workspace,
            source="openagents:agent-beta",
            channel=channel.name,
            content="I should not be able to post here",
        )

        assert resp.status_code == 403, resp.text
        assert "private_channel_post_forbidden" in resp.json()["message"]

    def test_private_channel_poll_with_member_scope_hides_non_member_events(self, client, db, workspace):
        channel = _set_channel_private(db, workspace)
        _add_workspace_member(db, workspace, "agent-beta")
        posted = _post_authorized_human_message(
            client, workspace,
            channel=channel.name,
            content="private message",
            email=_add_human_channel_member(db, channel),
        )
        assert posted.status_code == 200, posted.text

        resp = client.get(
            "/v1/events",
            params={
                "network": workspace["id"],
                "member": "agent-beta",
                "type": "workspace.message.posted",
            },
            headers=_headers(workspace),
        )

        assert resp.status_code == 200, resp.text
        assert resp.json()["data"]["events"] == []

    def test_unicode_member_mention_routes_when_agent_is_channel_member(self, client, db, workspace):
        channel_name = workspace["channel"]["name"]
        agent_name = "紫"
        _add_workspace_member(db, workspace, agent_name)
        join = _post_event(
            client, workspace,
            etype="network.channel.join",
            source="human:user",
            channel=channel_name,
            agent_name=agent_name,
        )
        assert join.status_code == 200, join.text

        resp = _post_message(
            client, workspace,
            source="human:user",
            channel=channel_name,
            content=f"@{agent_name}，请检查这个线程",
        )

        assert resp.status_code == 200, resp.text
        metadata = resp.json()["data"]["metadata"]
        assert metadata["target_agents"] == [agent_name]
