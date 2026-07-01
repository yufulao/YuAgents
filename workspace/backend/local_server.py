# -*- coding: utf-8 -*-
"""Local development server entry point.

The Windows Proactor event loop can surface aborted local polling sockets as
asyncio accept/connection-lost failures. The local launcher uses this wrapper
so uvicorn starts after the Windows selector loop policy is installed.
"""

from __future__ import annotations

import argparse
import asyncio
import sys


def _configure_event_loop_policy() -> None:
    if sys.platform == "win32" and hasattr(asyncio, "WindowsSelectorEventLoopPolicy"):
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())


def main() -> None:
    _configure_event_loop_policy()

    import uvicorn

    parser = argparse.ArgumentParser(description="Run the OpenAgents local backend")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    uvicorn.run("app.main:app", host=args.host, port=args.port, loop="asyncio")


if __name__ == "__main__":
    main()
