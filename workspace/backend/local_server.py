# -*- coding: utf-8 -*-
"""Local development server entry point.

The Windows Proactor event loop can surface aborted local polling sockets as
asyncio accept/connection-lost failures. The local launcher uses this wrapper
so uvicorn starts after the Windows selector loop policy is installed.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys

logger = logging.getLogger(__name__)


def _configure_event_loop_policy() -> None:
    if sys.platform == "win32" and hasattr(asyncio, "WindowsSelectorEventLoopPolicy"):
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())


def _local_loop_factory():
    if sys.platform == "win32":
        return asyncio.SelectorEventLoop()
    return asyncio.new_event_loop()


def main() -> None:
    _configure_event_loop_policy()

    import uvicorn

    parser = argparse.ArgumentParser(description="Run the OpenAgents local backend")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO)
    logger.info(
        "local backend: policy=%s loop_factory=%s",
        type(asyncio.get_event_loop_policy()).__name__,
        getattr(_local_loop_factory, "__name__", repr(_local_loop_factory)),
    )

    uvicorn.run("app.main:app", host=args.host, port=args.port, loop=_local_loop_factory)


if __name__ == "__main__":
    main()
