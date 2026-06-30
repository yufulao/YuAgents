# -*- coding: utf-8 -*-
"""Smoke + behaviour tests for the refactored background timer loop.

`_timer_loop` was split (commit on branch fix/timer-loop-pool-exhaustion)
into `_fire_due` (every cycle, short-lived session) and `_run_maintenance`
(every ~5 min, off the event loop via asyncio.to_thread). These tests run
both functions against an isolated SQLite DB to guard against import/session
regressions and verify the auto-archive sweep still works.

Both functions use `app.database.SessionLocal` directly (not the request
get_db dependency), so we monkeypatch it onto a dedicated engine.
"""

import asyncio
import time
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.database as database
import app.main as main
import app.pipeline_factory as pipeline_factory
import app.models  # noqa: F401 — register models on Base
from app.database import Base
from app.models import Channel, TimerRecord, Workspace


@pytest.fixture
def session_factory(monkeypatch):
    """Isolated in-memory DB with app.database.SessionLocal pointed at it."""
    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )

    @event.listens_for(eng, "before_cursor_execute", retval=True)
    def _rewrite_pg_to_sqlite(conn, cursor, statement, parameters, context, executemany):
        if "DEFAULT NOW()" in statement:
            statement = statement.replace("DEFAULT NOW()", "DEFAULT CURRENT_TIMESTAMP")
        if "DEFAULT gen_random_uuid()" in statement:
            statement = statement.replace("DEFAULT gen_random_uuid()", "")
        return statement, parameters

    Base.metadata.create_all(bind=eng)
    sl = sessionmaker(autocommit=False, autoflush=False, bind=eng)
    # _run_maintenance/_fire_due do `from app.database import SessionLocal`
    # at call time, which reads this attribute — so patching it is enough.
    monkeypatch.setattr(database, "SessionLocal", sl)
    yield sl
    Base.metadata.drop_all(bind=eng)


def test_run_maintenance_empty_db_ok(session_factory):
    # All three sweeps must run cleanly against empty tables (no firing path).
    main._run_maintenance()


def test_fire_due_empty_db_ok(session_factory):
    # No due timers/routines: runs the SELECTs, commits, closes — no pipeline.
    asyncio.run(main._fire_due())


def test_run_maintenance_archives_stale_thread(session_factory):
    s = session_factory()
    ws = Workspace(name="t", slug="t")
    s.add(ws)
    s.flush()
    stale_ms = int((time.time() - 40 * 86400) * 1000)  # 40 days ago
    s.add(Channel(workspace_id=ws.id, name="stale", status="active", last_event_at=stale_ms))
    s.add(Channel(workspace_id=ws.id, name="fresh", status="active",
                  last_event_at=int(time.time() * 1000)))
    s.commit()
    s.close()

    main._run_maintenance()

    s = session_factory()
    stale = s.execute(
        Channel.__table__.select().where(Channel.name == "stale")
    ).first()
    fresh = s.execute(
        Channel.__table__.select().where(Channel.name == "fresh")
    ).first()
    s.close()
    assert stale.status == "archived"
    assert fresh.status == "active"


def test_fire_due_repeating_user_timer_targets_selected_agent(session_factory, monkeypatch):
    captured = {}

    async def fake_process(event, ctx):
        captured["event"] = event
        captured["ctx"] = ctx

    monkeypatch.setattr(pipeline_factory.pipeline, "process", fake_process)

    s = session_factory()
    ws = Workspace(name="timer workspace", slug="timer-ws", password_hash="workspace-token")
    s.add(ws)
    s.flush()
    due_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    timer = TimerRecord(
        workspace_id=ws.id,
        channel_name="general",
        created_by="human:user",
        creator_type="human",
        target_agent="agent-beta",
        message="continue implementation",
        delay_seconds=60,
        repeat_interval_seconds=300,
        fires_at=due_at,
        status="active",
    )
    s.add(timer)
    s.commit()
    timer_id = timer.id
    s.close()

    asyncio.run(main._fire_due())

    s = session_factory()
    refreshed = s.query(TimerRecord).filter_by(id=timer_id).one()
    s.close()

    assert refreshed.status == "active"
    assert refreshed.fire_count == 1
    assert refreshed.fires_at.replace(tzinfo=timezone.utc) > due_at
    assert captured["event"].metadata["target_agents"] == ["agent-beta"]
    assert captured["event"].payload["message_type"] == "chat"
    assert "continue implementation" in captured["event"].payload["content"]
    assert captured["ctx"].agent_address == "openagents:agent-beta"
