'use client';

import {
  createContext,
  ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState
} from 'react';
import { useIsMobile } from '@/hooks/use-mobile';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { TimerItem, TodoItem } from '@/lib/types';

export type ViewMode = 'threads' | 'files' | 'knowledge' | 'browser' | 'tasks' | 'routines' | 'inbox' | 'connect';

/** On mobile, which pane is showing: the list or the detail */
export type MobilePane = 'list' | 'detail';

export interface SelectedQueueItem {
  channelName: string;
  queueId: string;
  content: string;
}

export type SelectedStatusItem =
  | { kind: 'timer'; channelName: string; timer: TimerItem }
  | { kind: 'todo'; channelName: string; todo: TodoItem };

const DEFAULT_SIDEBAR_WIDTH = 240;
const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 360;
const DEFAULT_LIST_PANE_WIDTH = 360;
const MIN_LIST_PANE_WIDTH = 260;
const MAX_LIST_PANE_WIDTH = 560;
const DEFAULT_AGENT_PANEL_WIDTH = 320;
const MIN_AGENT_PANEL_WIDTH = 280;
const MAX_AGENT_PANEL_WIDTH = 520;

function clampWidth(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function readStoredWidth(key: string, fallback: number, min: number, max: number) {
  if (typeof window === 'undefined') return fallback;
  const stored = Number(window.localStorage.getItem(key));
  return Number.isFinite(stored) ? clampWidth(stored, min, max) : fallback;
}

interface LayoutState {
  isMobile: boolean;
  isSidebarOpen: boolean;
  sidebarToggle: () => void;
  sidebarWidth: number;
  setSidebarWidth: (width: number) => void;
  listPaneWidth: number;
  setListPaneWidth: (width: number) => void;
  isListPaneCollapsed: boolean;
  toggleListPaneCollapsed: () => void;
  agentPanelWidth: number;
  setAgentPanelWidth: (width: number) => void;
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  selectedAgentName: string | null;
  setSelectedAgentName: (name: string | null) => void;
  selectedQueueItem: SelectedQueueItem | null;
  setSelectedQueueItem: (item: SelectedQueueItem | null) => void;
  selectedStatusItem: SelectedStatusItem | null;
  setSelectedStatusItem: (item: SelectedStatusItem | null) => void;
  isAgentPanelOpen: boolean;
  isQueuePanelOpen: boolean;
  isStatusPanelOpen: boolean;
  /** Which pane is visible on mobile (ignored on desktop) */
  mobilePane: MobilePane;
  /** Navigate to detail pane on mobile */
  openMobileDetail: () => void;
  /** Navigate back to list pane on mobile */
  openMobileList: () => void;
  /** Whether the detail pane is expanded to full width (hides sidebar + list) */
  isDetailExpanded: boolean;
  toggleDetailExpanded: () => void;
  /** Experimental: show browser tab side-by-side with chat */
  splitBrowser: boolean;
  setSplitBrowser: (v: boolean) => void;
  /** Whether the browser live preview panel is currently showing */
  showBrowserPreview: boolean;
  setShowBrowserPreview: (v: boolean) => void;
}

const LayoutContext = createContext<LayoutState | undefined>(undefined);

export function LayoutProvider({ children }: { children: ReactNode }) {
  const isMobile = useIsMobile();
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidthState] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [listPaneWidth, setListPaneWidthState] = useState(DEFAULT_LIST_PANE_WIDTH);
  const [isListPaneCollapsed, setIsListPaneCollapsed] = useState(false);
  const [agentPanelWidth, setAgentPanelWidthState] = useState(DEFAULT_AGENT_PANEL_WIDTH);
  const [viewMode, setViewMode] = useState<ViewMode>('threads');
  const [selectedAgentName, setSelectedAgentName] = useState<string | null>(null);
  const [selectedQueueItem, setSelectedQueueItem] = useState<SelectedQueueItem | null>(null);
  const [selectedStatusItem, setSelectedStatusItem] = useState<SelectedStatusItem | null>(null);
  const [mobilePane, setMobilePane] = useState<MobilePane>('list');
  const [isDetailExpanded, setIsDetailExpanded] = useState(false);
  const [splitBrowser, setSplitBrowser] = useState(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('x-split-browser') === '1';
  });

  const handleSetSplitBrowser = (v: boolean) => {
    setSplitBrowser(v);
    localStorage.setItem('x-split-browser', v ? '1' : '0');
  };

  const [showBrowserPreview, setShowBrowserPreview] = useState(false);

  useEffect(() => {
    setSidebarWidthState(readStoredWidth('x-sidebar-width', DEFAULT_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH));
    setListPaneWidthState(readStoredWidth('x-list-pane-width', DEFAULT_LIST_PANE_WIDTH, MIN_LIST_PANE_WIDTH, MAX_LIST_PANE_WIDTH));
    setIsListPaneCollapsed(window.localStorage.getItem('x-list-pane-collapsed') === '1');
    setAgentPanelWidthState(readStoredWidth('x-agent-panel-width', DEFAULT_AGENT_PANEL_WIDTH, MIN_AGENT_PANEL_WIDTH, MAX_AGENT_PANEL_WIDTH));
  }, []);

  const handleSetSelectedAgentName = (name: string | null) => {
    setSelectedAgentName(name);
    if (name) {
      setSelectedQueueItem(null);
      setSelectedStatusItem(null);
    }
  };
  const handleSetSelectedQueueItem = (item: SelectedQueueItem | null) => {
    setSelectedQueueItem(item);
    if (item) {
      setSelectedAgentName(null);
      setSelectedStatusItem(null);
    }
  };
  const handleSetSelectedStatusItem = (item: SelectedStatusItem | null) => {
    setSelectedStatusItem(item);
    if (item) {
      setSelectedAgentName(null);
      setSelectedQueueItem(null);
    }
  };
  const isAgentPanelOpen = selectedAgentName !== null;
  const isQueuePanelOpen = selectedQueueItem !== null;
  const isStatusPanelOpen = selectedStatusItem !== null;
  const openMobileDetail = () => setMobilePane('detail');
  const openMobileList = () => setMobilePane('list');
  const toggleDetailExpanded = () => setIsDetailExpanded((v) => !v);

  const setSidebarWidth = (width: number) => {
    const next = clampWidth(width, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH);
    setSidebarWidthState(next);
    window.localStorage.setItem('x-sidebar-width', String(next));
  };

  const setListPaneWidth = (width: number) => {
    const next = clampWidth(width, MIN_LIST_PANE_WIDTH, MAX_LIST_PANE_WIDTH);
    setListPaneWidthState(next);
    window.localStorage.setItem('x-list-pane-width', String(next));
  };

  const toggleListPaneCollapsed = () => {
    setIsListPaneCollapsed((value) => {
      const next = !value;
      window.localStorage.setItem('x-list-pane-collapsed', next ? '1' : '0');
      return next;
    });
  };

  const setAgentPanelWidth = (width: number) => {
    const next = clampWidth(width, MIN_AGENT_PANEL_WIDTH, MAX_AGENT_PANEL_WIDTH);
    setAgentPanelWidthState(next);
    window.localStorage.setItem('x-agent-panel-width', String(next));
  };

  const cssVariables = useMemo(() => ({
    '--sidebar-width': `${sidebarWidth}px`,
    '--sidebar-width-collapsed': '52px',
    '--agent-panel-width': `${agentPanelWidth}px`,
    '--header-height-mobile': '60px',
  } as React.CSSProperties), [agentPanelWidth, sidebarWidth]);

  const sidebarToggle = () => setIsSidebarOpen((open) => !open);

  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;

    Object.entries(cssVariables).forEach(([prop, val]) => {
      html.style.setProperty(prop, val as string);
    });

    body.setAttribute('data-sidebar-open', isSidebarOpen.toString());

    return () => {
      Object.keys(cssVariables).forEach((prop) => {
        html.style.removeProperty(prop);
      });
      body.removeAttribute('data-sidebar-open');
    };
  }, [cssVariables, isSidebarOpen]);

  return (
    <LayoutContext.Provider value={{
      isMobile,
      isSidebarOpen,
      sidebarToggle,
      sidebarWidth,
      setSidebarWidth,
      listPaneWidth,
      setListPaneWidth,
      isListPaneCollapsed,
      toggleListPaneCollapsed,
      agentPanelWidth,
      setAgentPanelWidth,
      viewMode,
      setViewMode,
      selectedAgentName,
      setSelectedAgentName: handleSetSelectedAgentName,
      selectedQueueItem,
      setSelectedQueueItem: handleSetSelectedQueueItem,
      selectedStatusItem,
      setSelectedStatusItem: handleSetSelectedStatusItem,
      isAgentPanelOpen,
      isQueuePanelOpen,
      isStatusPanelOpen,
      mobilePane,
      openMobileDetail,
      openMobileList,
      isDetailExpanded,
      toggleDetailExpanded,
      splitBrowser,
      setSplitBrowser: handleSetSplitBrowser,
      showBrowserPreview,
      setShowBrowserPreview,
    }}>
      <div data-slot="layout-wrapper" className="flex grow">
        <TooltipProvider delayDuration={0}>
          {children}
        </TooltipProvider>
      </div>
    </LayoutContext.Provider>
  );
}

export const useLayout = () => {
  const context = useContext(LayoutContext);
  if (!context) {
    throw new Error('useLayout must be used within a LayoutProvider');
  }
  return context;
};
