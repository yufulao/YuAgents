# -*- coding: utf-8 -*-
"""Tests for workspace timer endpoints."""


class TestTimers:
    def test_human_timer_requires_target_agent(self, client, workspace):
        resp = client.post(
            "/v1/timers",
            headers={"X-Workspace-Token": workspace["token"]},
            json={
                "network": workspace["id"],
                "channel": workspace["channel"]["name"],
                "source": "human:user",
                "creator_type": "human",
                "delay": 60,
                "message": "keep going",
            },
        )

        assert resp.status_code == 400
        assert "target_agent" in resp.json()["message"]

    def test_human_timer_is_visible_and_only_user_cancellable(self, client, workspace):
        channel = workspace["channel"]["name"]
        create = client.post(
            "/v1/timers",
            headers={"X-Workspace-Token": workspace["token"]},
            json={
                "network": workspace["id"],
                "channel": channel,
                "source": "human:user",
                "creator_type": "human",
                "target_agent": "agent-alpha",
                "delay": 60,
                "repeat_interval_seconds": 300,
                "message": "continue the current task",
            },
        )

        assert create.status_code == 200
        timer = create.json()["data"]
        assert timer["creator_type"] == "human"
        assert timer["target_agent"] == "agent-alpha"
        assert timer["repeat_interval_seconds"] == 300
        assert timer["fire_count"] == 0

        no_source_cancel = client.delete(
            f"/v1/timers/{timer['id']}",
            headers={"X-Workspace-Token": workspace["token"]},
        )
        assert no_source_cancel.status_code == 403

        agent_cancel = client.delete(
            f"/v1/timers/{timer['id']}",
            params={"source": "openagents:agent-alpha"},
            headers={"X-Workspace-Token": workspace["token"]},
        )
        assert agent_cancel.status_code == 403

        listed = client.get(
            "/v1/timers",
            params={"network": workspace["id"], "channel": channel},
            headers={"X-Workspace-Token": workspace["token"]},
        )
        assert listed.status_code == 200
        assert [item["id"] for item in listed.json()["data"]["timers"]] == [timer["id"]]

        user_cancel = client.delete(
            f"/v1/timers/{timer['id']}",
            params={"source": "human:user"},
            headers={"X-Workspace-Token": workspace["token"]},
        )
        assert user_cancel.status_code == 200
        assert user_cancel.json()["data"]["status"] == "cancelled"

    def test_human_timer_can_be_edited_by_user(self, client, workspace):
        channel = workspace["channel"]["name"]
        create = client.post(
            "/v1/timers",
            headers={"X-Workspace-Token": workspace["token"]},
            json={
                "network": workspace["id"],
                "channel": channel,
                "source": "human:user",
                "creator_type": "human",
                "target_agent": "agent-alpha",
                "delay": 60,
                "repeat_interval_seconds": 300,
                "message": "old prompt",
            },
        )
        assert create.status_code == 200
        timer = create.json()["data"]

        agent_edit = client.patch(
            f"/v1/timers/{timer['id']}",
            headers={"X-Workspace-Token": workspace["token"]},
            json={"source": "openagents:agent-alpha", "message": "agent edit"},
        )
        assert agent_edit.status_code == 403

        update = client.patch(
            f"/v1/timers/{timer['id']}",
            headers={"X-Workspace-Token": workspace["token"]},
            json={
                "source": "human:user",
                "message": "new prompt",
                "delay": 120,
                "repeat_interval_seconds": None,
                "target_agent": "agent-beta",
            },
        )
        assert update.status_code == 200
        data = update.json()["data"]
        assert data["message"] == "new prompt"
        assert data["delay_seconds"] == 120
        assert data["repeat_interval_seconds"] is None
        assert data["target_agent"] == "agent-beta"
