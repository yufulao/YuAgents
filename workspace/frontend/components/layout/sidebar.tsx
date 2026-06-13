'use client';

import { useCallback, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { SidebarContent } from './sidebar-content';
import { SidebarHeader } from './sidebar-header';
import { useLayout } from './layout-context';
import { cn } from '@/lib/utils';

export function Sidebar() {
  const sidebarRef = useRef<HTMLElement | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const { isSidebarOpen, sidebarWidth, setSidebarWidth } = useLayout();

  const handleResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isSidebarOpen) return;
    event.preventDefault();

    const left = sidebarRef.current?.getBoundingClientRect().left ?? 0;
    const body = document.body;
    const previousCursor = body.style.cursor;
    const previousUserSelect = body.style.userSelect;

    setIsResizing(true);
    body.style.cursor = 'col-resize';
    body.style.userSelect = 'none';

    const updateWidth = (clientX: number) => {
      setSidebarWidth(clientX - left);
    };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      updateWidth(moveEvent.clientX);
    };

    const handlePointerUp = () => {
      body.style.cursor = previousCursor;
      body.style.userSelect = previousUserSelect;
      setIsResizing(false);
      window.removeEventListener('pointermove', handlePointerMove);
    };

    updateWidth(event.clientX);
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp, { once: true });
  }, [isSidebarOpen, setSidebarWidth]);

  const handleResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!isSidebarOpen) return;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setSidebarWidth(sidebarWidth - 16);
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      setSidebarWidth(sidebarWidth + 16);
    }
  }, [isSidebarOpen, setSidebarWidth, sidebarWidth]);

  return (
    <aside
      ref={sidebarRef}
      className={cn(
        'fixed overflow-hidden bg-zinc-100 dark:bg-zinc-900 top-0 bottom-0 start-0 z-20 flex items-stretch shrink-0 w-(--sidebar-width) in-data-[sidebar-open=false]:w-(--sidebar-width-collapsed)',
        !isResizing && 'transition-all duration-300',
      )}
    >
      <div
        className={cn(
          'grow shrink-0 flex flex-col',
          !isResizing && 'transition-all duration-300',
        )}
        style={{ width: isSidebarOpen ? 'var(--sidebar-width)' : 'var(--sidebar-width-collapsed)' }}
      >
        <SidebarHeader />
        <SidebarContent />
      </div>
      {isSidebarOpen && (
        <div
          role="separator"
          aria-label="调整左侧边栏宽度"
          aria-orientation="vertical"
          aria-valuenow={sidebarWidth}
          tabIndex={0}
          onPointerDown={handleResizePointerDown}
          onKeyDown={handleResizeKeyDown}
          className="group absolute right-0 top-0 bottom-0 z-30 hidden w-2 cursor-col-resize items-stretch justify-center outline-none hover:bg-primary/10 focus-visible:bg-primary/10 lg:flex"
        >
          <span className="absolute right-0 top-2 bottom-2 w-px rounded-full bg-border opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
        </div>
      )}
    </aside>
  );
}
