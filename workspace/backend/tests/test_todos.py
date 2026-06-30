# -*- coding: utf-8 -*-
"""Tests for workspace todo endpoints."""


class TestTodos:
    def test_todo_can_be_edited_by_id(self, client, workspace):
        channel = workspace["channel"]["name"]
        put = client.put(
            "/v1/todos",
            headers={"X-Workspace-Token": workspace["token"]},
            json={
                "network": workspace["id"],
                "channel": channel,
                "source": "openagents:agent-alpha",
                "todos": [
                    {"content": "first item", "status": "in_progress", "assignee": "agent-alpha"},
                    {"content": "second item", "status": "pending", "assignee": "agent-alpha"},
                ],
            },
        )
        assert put.status_code == 200
        todos = put.json()["data"]["todos"]
        target = todos[0]

        update = client.patch(
            f"/v1/todos/{target['id']}",
            headers={"X-Workspace-Token": workspace["token"]},
            json={"content": "edited first item", "assignee": "agent-beta"},
        )
        assert update.status_code == 200
        edited = update.json()["data"]
        assert edited["content"] == "edited first item"
        assert edited["status"] == "in_progress"
        assert edited["assignee"] == "agent-beta"

        listed = client.get(
            "/v1/todos",
            params={"network": workspace["id"], "channel": channel, "all": True},
            headers={"X-Workspace-Token": workspace["token"]},
        )
        assert listed.status_code == 200
        rows = listed.json()["data"]["todos"]
        assert [row["content"] for row in rows] == ["edited first item", "second item"]
