# -*- coding: utf-8 -*-
"""
Tests for workspace CRUD endpoints.
"""

import pytest
from app.config import config


class TestCreateWorkspace:
    """POST /v1/workspaces — create a workspace."""

    def test_create_workspace(self, client):
        """Create workspace returns ID, slug, token, and default channel."""
        resp = client.post("/v1/workspaces", json={
            "name": "My Workspace",
            "agent_name": "test-agent",
        })
        assert resp.status_code == 200
        data = resp.json()["data"]
        assert "workspaceId" in data
        assert "slug" in data
        assert "token" in data
        assert "channel" in data
        assert data["name"] == "My Workspace"

    def test_create_workspace_has_channel_with_master(self, client):
        """Default channel has the creating agent as master and participant."""
        resp = client.post("/v1/workspaces", json={
            "name": "Test",
            "agent_name": "agent-alpha",
        })
        channel = resp.json()["data"]["channel"]
        assert channel["masterAgent"] == "agent-alpha"
        assert "agent-alpha" in channel["participants"]

    def test_create_workspace_with_email(self, client):
        """Creator email is stored."""
        resp = client.post("/v1/workspaces", json={
            "name": "Test",
            "agent_name": "agent-alpha",
            "creator_email": "user@example.com",
        })
        data = resp.json()["data"]
        ws_id = data["workspaceId"]
        detail = client.get(f"/v1/workspaces/{ws_id}",
                            headers={"X-Workspace-Token": data["token"]})
        assert detail.json()["data"]["creatorEmail"] == "user@example.com"

    def test_create_workspace_can_be_disabled(self, client, monkeypatch):
        """Remote relay deployments can require existing slug/token only."""
        monkeypatch.setattr(config, "WORKSPACE_CREATION_ENABLED", False)

        resp = client.post("/v1/workspaces", json={
            "name": "Should Not Create",
            "agent_name": "test-agent",
        })

        assert resp.status_code == 403
        assert "disabled" in resp.json()["message"]

    def test_create_workspace_rejects_duplicate_active_name(self, client):
        """Workspace display names are unique so name-based login is unambiguous."""
        first = client.post("/v1/workspaces", json={"name": "UniqueRoom"})
        assert first.status_code == 200

        duplicate = client.post("/v1/workspaces", json={"name": "UniqueRoom"})
        assert duplicate.status_code == 400
        assert "already exists" in duplicate.json()["message"]


class TestGetWorkspace:
    """GET /v1/workspaces/{id} — get workspace details."""

    def test_get_workspace_by_id(self, client, workspace):
        """Fetch workspace by ID."""
        resp = client.get(f"/v1/workspaces/{workspace['id']}",
                          headers={"X-Workspace-Token": workspace["token"]})
        assert resp.status_code == 200
        data = resp.json()["data"]
        assert data["workspaceId"] == workspace["id"]
        assert data["name"] == workspace["name"]

    def test_get_workspace_by_slug(self, client, workspace):
        """Fetch workspace by slug."""
        resp = client.get(f"/v1/workspaces/{workspace['slug']}",
                          headers={"X-Workspace-Token": workspace["token"]})
        assert resp.status_code == 200
        assert resp.json()["data"]["workspaceId"] == workspace["id"]

    def test_workspace_directory_can_be_disabled(self, client, workspace, monkeypatch):
        """Remote relay deployments can hide workspace enumeration."""
        monkeypatch.setattr(config, "WORKSPACE_DIRECTORY_ENABLED", False)

        listing = client.get("/v1/workspaces")
        assert listing.status_code == 403
        assert "directory is disabled" in listing.json()["message"]

        detail = client.get(
            f"/v1/workspaces/{workspace['slug']}",
            headers={"X-Workspace-Token": workspace["token"]},
        )
        assert detail.status_code == 200
        assert detail.json()["data"]["workspaceId"] == workspace["id"]

    def test_local_token_discovery_only_in_local_mode(self, client, workspace, monkeypatch):
        """Local Web can recover tokens; remote relay deployments cannot."""
        token = client.get(f"/v1/workspaces/{workspace['slug']}/local-token")
        assert token.status_code == 200
        assert token.json()["data"]["token"] == workspace["token"]

        monkeypatch.setattr(config, "WORKSPACE_DIRECTORY_ENABLED", False)
        disabled = client.get(f"/v1/workspaces/{workspace['slug']}/local-token")
        assert disabled.status_code == 403

    def test_get_workspace_includes_agents(self, client, workspace):
        """Workspace detail includes agent list."""
        resp = client.get(f"/v1/workspaces/{workspace['id']}",
                          headers={"X-Workspace-Token": workspace["token"]})
        agents = resp.json()["data"]["agents"]
        assert len(agents) >= 1
        assert agents[0]["agentName"] == "agent-alpha"
        assert agents[0]["role"] == "master"

    def test_get_workspace_projects_claimed_task_progress(self, client, workspace, db):
        """Workspace agent detail includes active task progress."""
        from app.models import WorkspaceTask

        joined = client.post("/v1/join", json={
            "agent_name": "agent-beta",
            "token": workspace["token"],
            "network": workspace["id"],
            "agent_type": "codex",
        })
        assert joined.status_code == 200

        task = WorkspaceTask(
            workspace_id=workspace["id"],
            channel_name="general",
            title="ENG-124 detail progress",
            description="Detailed workspace task context",
            status="in_progress",
            priority="normal",
            assignee="agent-beta",
            claimed_by="agent-beta",
            created_by="agent-alpha",
            result="Workspace task latest result",
        )
        db.add(task)
        db.commit()

        resp = client.get(f"/v1/workspaces/{workspace['id']}",
                          headers={"X-Workspace-Token": workspace["token"]})
        assert resp.status_code == 200
        beta = next(a for a in resp.json()["data"]["agents"] if a["agentName"] == "agent-beta")
        assert beta["presenceStatus"] == "online"
        assert beta["activityState"] == "thinking"
        assert beta["workloadState"] == "active"
        assert beta["displayStatus"] == "thinking"
        assert beta["hasActiveWork"] is True
        assert beta["activitySummary"] == "进行中: ENG-124 detail progress"
        assert beta["activeTask"]["id"] == task.id
        assert beta["activeTask"]["description"] == "Detailed workspace task context"
        assert beta["activeTask"]["result"] == "Workspace task latest result"
        assert beta["activeTask"]["channelName"] == "general"

    def test_get_nonexistent_workspace(self, client):
        """Nonexistent workspace returns 404."""
        resp = client.get("/v1/workspaces/nonexistent")
        assert resp.status_code == 404

    def test_resolve_workspace_by_name_returns_canonical_slug(self, client, workspace):
        """Entry form can accept a unique workspace display name."""
        resp = client.post(
            "/v1/workspaces/resolve",
            headers={"X-Workspace-Token": workspace["token"]},
            json={"workspace": workspace["name"]},
        )

        assert resp.status_code == 200
        data = resp.json()["data"]
        assert data["workspaceId"] == workspace["id"]
        assert data["slug"] == workspace["slug"]

    def test_resolve_workspace_name_requires_valid_token(self, client, workspace):
        """A matching name is not enough without the workspace token."""
        resp = client.post(
            "/v1/workspaces/resolve",
            headers={"X-Workspace-Token": "wrong"},
            json={"workspace": workspace["name"]},
        )

        assert resp.status_code == 401

    def test_resolve_workspace_name_stays_unambiguous(self, client):
        """Duplicate names are rejected before name-based entry can become ambiguous."""
        one = client.post("/v1/workspaces", json={"name": "DuplicateName"}).json()["data"]
        duplicate = client.post("/v1/workspaces", json={"name": "DuplicateName"})
        assert duplicate.status_code == 400

        resp = client.post(
            "/v1/workspaces/resolve",
            headers={"X-Workspace-Token": one["token"]},
            json={"workspace": "DuplicateName"},
        )

        assert resp.status_code == 200
        assert resp.json()["data"]["workspaceId"] == one["workspaceId"]

        by_slug = client.post(
            "/v1/workspaces/resolve",
            headers={"X-Workspace-Token": one["token"]},
            json={"workspace": one["slug"]},
        )
        assert by_slug.status_code == 200
        assert by_slug.json()["data"]["workspaceId"] == one["workspaceId"]


class TestUpdateWorkspace:
    """PATCH /v1/workspaces/{id} — update workspace."""

    def test_update_name(self, client, workspace):
        """Update workspace name."""
        resp = client.patch(f"/v1/workspaces/{workspace['id']}", json={
            "name": "Updated Name",
        }, headers={"X-Workspace-Token": workspace["token"]})
        assert resp.status_code == 200
        assert resp.json()["data"]["name"] == "Updated Name"

    def test_update_name_rejects_duplicate_active_name(self, client, workspace):
        """Renaming cannot create ambiguous workspace names."""
        other = client.post("/v1/workspaces", json={"name": "Taken Name"}).json()["data"]

        resp = client.patch(
            f"/v1/workspaces/{workspace['id']}",
            json={"name": "Taken Name"},
            headers={"X-Workspace-Token": workspace["token"]},
        )

        assert resp.status_code == 400
        assert "already exists" in resp.json()["message"]

        unchanged = client.get(
            f"/v1/workspaces/{workspace['id']}",
            headers={"X-Workspace-Token": workspace["token"]},
        )
        assert unchanged.json()["data"]["name"] == workspace["name"]

        delete_other = client.delete(
            f"/v1/workspaces/{other['slug']}",
            headers={"X-Workspace-Token": other["token"]},
        )
        assert delete_other.status_code == 200

    def test_update_settings(self, client, workspace):
        """Update workspace settings."""
        resp = client.patch(f"/v1/workspaces/{workspace['id']}", json={
            "settings": {"theme": "dark"},
        }, headers={"X-Workspace-Token": workspace["token"]})
        assert resp.status_code == 200
        assert resp.json()["data"]["settings"]["theme"] == "dark"

    def test_browser_enabled_defaults_false(self, client, workspace):
        """A fresh workspace has browserEnabled = false."""
        resp = client.get(f"/v1/workspaces/{workspace['id']}",
                          headers={"X-Workspace-Token": workspace["token"]})
        assert resp.status_code == 200
        assert resp.json()["data"]["browserEnabled"] is False

    def test_update_browser_enabled_true(self, client, workspace):
        """Flip browser_enabled on; response surfaces it at the top level."""
        resp = client.patch(f"/v1/workspaces/{workspace['id']}", json={
            "browser_enabled": True,
        }, headers={"X-Workspace-Token": workspace["token"]})
        assert resp.status_code == 200
        data = resp.json()["data"]
        assert data["browserEnabled"] is True
        # And it's mirrored inside the settings dict
        assert data["settings"].get("browser_enabled") is True

    def test_browser_enabled_round_trips(self, client, workspace):
        """A subsequent GET reflects the persisted toggle."""
        client.patch(f"/v1/workspaces/{workspace['id']}",
                     json={"browser_enabled": True},
                     headers={"X-Workspace-Token": workspace["token"]})
        resp = client.get(f"/v1/workspaces/{workspace['id']}",
                          headers={"X-Workspace-Token": workspace["token"]})
        assert resp.json()["data"]["browserEnabled"] is True

    def test_browser_enabled_preserves_other_settings(self, client, workspace):
        """Flipping browser_enabled doesn't trample unrelated settings keys."""
        client.patch(f"/v1/workspaces/{workspace['id']}",
                     json={"settings": {"theme": "dark"}},
                     headers={"X-Workspace-Token": workspace["token"]})
        resp = client.patch(f"/v1/workspaces/{workspace['id']}", json={
            "browser_enabled": True,
        }, headers={"X-Workspace-Token": workspace["token"]})
        data = resp.json()["data"]
        assert data["settings"]["theme"] == "dark"
        assert data["settings"]["browser_enabled"] is True
        assert data["browserEnabled"] is True

    def test_browser_enabled_false_clears_panel(self, client, workspace):
        """Toggling off persists the false value."""
        client.patch(f"/v1/workspaces/{workspace['id']}",
                     json={"browser_enabled": True},
                     headers={"X-Workspace-Token": workspace["token"]})
        resp = client.patch(f"/v1/workspaces/{workspace['id']}", json={
            "browser_enabled": False,
        }, headers={"X-Workspace-Token": workspace["token"]})
        assert resp.json()["data"]["browserEnabled"] is False


class TestDeleteWorkspace:
    """DELETE /v1/workspaces/{id} — soft-delete workspace."""

    def test_delete_workspace(self, client, workspace):
        """Soft-delete sets status to 'deleted'."""
        resp = client.delete(
            f"/v1/workspaces/{workspace['id']}",
            headers={"X-Workspace-Token": workspace["token"]},
        )
        assert resp.status_code == 200
        assert resp.json()["data"]["status"] == "deleted"

    def test_deleted_workspace_hidden_from_list(self, client, workspace):
        """Deleted workspace doesn't appear in list."""
        client.delete(
            f"/v1/workspaces/{workspace['id']}",
            headers={"X-Workspace-Token": workspace["token"]},
        )
        resp = client.get("/v1/workspaces")
        ids = [w["workspaceId"] for w in resp.json()["data"]]
        assert workspace["id"] not in ids

    # ------------------------------------------------------------------
    # Auth enforcement (CVE-1)
    # ------------------------------------------------------------------

    def test_delete_no_credentials_returns_401(self, client, workspace):
        """Unauthenticated DELETE is rejected — workspace must not be deleted."""
        resp = client.delete(f"/v1/workspaces/{workspace['id']}")
        assert resp.status_code == 401

        # Workspace must still exist
        get = client.get(
            f"/v1/workspaces/{workspace['id']}",
            headers={"X-Workspace-Token": workspace["token"]},
        )
        assert get.status_code == 200

    def test_delete_wrong_token_returns_401(self, client, workspace):
        """Wrong token is rejected — workspace must not be deleted."""
        resp = client.delete(
            f"/v1/workspaces/{workspace['id']}",
            headers={"X-Workspace-Token": "not-the-right-token"},
        )
        assert resp.status_code == 401

    def test_delete_by_slug_with_valid_token(self, client, workspace):
        """Deletion by slug also works with a valid token."""
        resp = client.delete(
            f"/v1/workspaces/{workspace['slug']}",
            headers={"X-Workspace-Token": workspace["token"]},
        )
        assert resp.status_code == 200
        assert resp.json()["data"]["status"] == "deleted"

    def test_delete_nonexistent_workspace_returns_404(self, client):
        """Deleting a nonexistent workspace returns 404 regardless of token."""
        resp = client.delete(
            "/v1/workspaces/00000000-0000-0000-0000-000000000000",
            headers={"X-Workspace-Token": "any-token"},
        )
        assert resp.status_code == 404

    def test_deleted_workspace_is_no_longer_accessible(self, client, workspace):
        """After deletion the workspace returns 404 on GET."""
        client.delete(
            f"/v1/workspaces/{workspace['id']}",
            headers={"X-Workspace-Token": workspace["token"]},
        )
        resp = client.get(
            f"/v1/workspaces/{workspace['id']}",
            headers={"X-Workspace-Token": workspace["token"]},
        )
        assert resp.status_code == 404

    def test_delete_already_deleted_workspace_returns_404(self, client, workspace):
        """A second DELETE on an already-deleted workspace returns 404."""
        headers = {"X-Workspace-Token": workspace["token"]}
        client.delete(f"/v1/workspaces/{workspace['id']}", headers=headers)
        resp = client.delete(f"/v1/workspaces/{workspace['id']}", headers=headers)
        assert resp.status_code == 404


class TestListWorkspaces:
    """GET /v1/workspaces — list workspaces."""

    def test_list_empty(self, client):
        """Empty workspace list."""
        resp = client.get("/v1/workspaces")
        assert resp.status_code == 200
        assert resp.json()["data"] == []

    def test_list_returns_workspaces(self, client, workspace):
        """Workspaces appear in list."""
        resp = client.get("/v1/workspaces")
        assert len(resp.json()["data"]) >= 1

    def test_list_filter_by_agent(self, client, workspace):
        """Filter workspaces by agent membership."""
        resp = client.get("/v1/workspaces", params={"agent_name": "agent-alpha"})
        assert len(resp.json()["data"]) >= 1

        resp2 = client.get("/v1/workspaces", params={"agent_name": "nonexistent"})
        assert resp2.json()["data"] == []


class TestRotateToken:
    """POST /v1/workspaces/{id}/rotate-token — rotate workspace token."""

    def test_rotate_with_valid_token(self, client, workspace):
        """Rotating with current token returns a new token."""
        resp = client.post(
            f"/v1/workspaces/{workspace['id']}/rotate-token",
            headers={"X-Workspace-Token": workspace["token"]},
        )
        assert resp.status_code == 200
        data = resp.json()["data"]
        assert "token" in data
        assert data["token"] != workspace["token"]
        assert data["workspace_id"] == workspace["id"]

    def test_old_token_stops_working(self, client, workspace):
        """After rotation, the old token should no longer work."""
        old_token = workspace["token"]
        resp = client.post(
            f"/v1/workspaces/{workspace['id']}/rotate-token",
            headers={"X-Workspace-Token": old_token},
        )
        new_token = resp.json()["data"]["token"]

        # Old token should fail
        resp2 = client.post(
            f"/v1/workspaces/{workspace['id']}/rotate-token",
            headers={"X-Workspace-Token": old_token},
        )
        assert resp2.status_code == 401

        # New token should work
        resp3 = client.post(
            f"/v1/workspaces/{workspace['id']}/rotate-token",
            headers={"X-Workspace-Token": new_token},
        )
        assert resp3.status_code == 200

    def test_rotate_no_credentials(self, client, workspace):
        """Rotation without credentials returns 401."""
        resp = client.post(f"/v1/workspaces/{workspace['id']}/rotate-token")
        assert resp.status_code == 401

    def test_rotate_nonexistent_workspace(self, client):
        """Rotation on nonexistent workspace returns 404."""
        resp = client.post(
            "/v1/workspaces/nonexistent/rotate-token",
            headers={"X-Workspace-Token": "any"},
        )
        assert resp.status_code == 404

    def test_new_token_works_for_join(self, client, workspace):
        """After rotation, agents can join using the new token."""
        resp = client.post(
            f"/v1/workspaces/{workspace['id']}/rotate-token",
            headers={"X-Workspace-Token": workspace["token"]},
        )
        new_token = resp.json()["data"]["token"]

        # Join with new token
        join_resp = client.post("/v1/join", json={
            "agent_name": "new-agent",
            "token": new_token,
            "network": workspace["id"],
        })
        assert join_resp.status_code == 200


class TestRemoveMember:
    """DELETE /v1/workspaces/{id}/members/{agent_name} — remove member."""

    def test_remove_member(self, client, workspace):
        """Remove an agent from workspace."""
        # Join an agent first
        client.post("/v1/join", json={
            "agent_name": "agent-to-remove",
            "token": workspace["token"],
            "network": workspace["id"],
        })

        # Remove it
        resp = client.delete(
            f"/v1/workspaces/{workspace['id']}/members/agent-to-remove",
            headers={"X-Workspace-Token": workspace["token"]},
        )
        assert resp.status_code == 200
        assert resp.json()["data"]["removed"] is True

        # Verify agent no longer in discover
        disc = client.get("/v1/discover", params={"network": workspace["id"]},
                          headers={"X-Workspace-Token": workspace["token"]})
        names = [a["address"] for a in disc.json()["data"]["agents"]]
        assert "openagents:agent-to-remove" not in names

    def test_remove_nonexistent_member(self, client, workspace):
        """Removing nonexistent member returns 404."""
        resp = client.delete(
            f"/v1/workspaces/{workspace['id']}/members/nonexistent-agent",
            headers={"X-Workspace-Token": workspace["token"]},
        )
        assert resp.status_code == 404

    def test_remove_no_credentials(self, client, workspace):
        """Removal without credentials returns 401."""
        resp = client.delete(
            f"/v1/workspaces/{workspace['id']}/members/agent-alpha",
        )
        assert resp.status_code == 401
