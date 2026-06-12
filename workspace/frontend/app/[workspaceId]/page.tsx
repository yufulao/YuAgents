'use client';

import { use, Suspense, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { WorkspaceProvider, useWorkspace } from '@/lib/workspace-context';
import { LayoutProvider } from '@/components/layout/layout-context';
import { Wrapper } from '@/components/layout/wrapper';

function WorkspaceLoadingSplash() {
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-5">
        <img
          src="/logo-icon.png"
          alt="OpenAgents"
          className="size-16 animate-[pulse_2s_ease-in-out_infinite] dark:hidden"
        />
        <img
          src="/logo-white.png"
          alt="OpenAgents"
          className="size-16 animate-[pulse_2s_ease-in-out_infinite] hidden dark:block"
        />
        <div className="text-center">
          <h1 className="text-xl font-semibold tracking-tight">OpenAgents</h1>
          <p className="text-sm text-muted-foreground mt-0.5">工作区加载中</p>
        </div>
      </div>
      <div className="absolute bottom-0 left-0 right-0 h-1 bg-muted overflow-hidden">
        <div className="h-full w-1/3 bg-primary rounded-full animate-[loading-bar_1.5s_ease-in-out_infinite]" />
      </div>
      <style>{`
        @keyframes loading-bar {
          0% { transform: translateX(-100%); }
          50% { transform: translateX(150%); }
          100% { transform: translateX(400%); }
        }
      `}</style>
    </div>
  );
}

function IdentityGate({ children }: { children: React.ReactNode }) {
  const { currentUser, setUserName } = useWorkspace();

  useEffect(() => {
    if (!currentUser.name.trim()) {
      setUserName('访客');
    }
  }, [currentUser.name, setUserName]);

  return <>{children}</>;
}

function WorkspaceContent({ workspaceId }: { workspaceId: string }) {
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  if (!token) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-8 text-center">
        <h1 className="text-xl font-semibold text-destructive">缺少工作区 Token</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          请在 URL 后添加 <code className="rounded bg-muted px-2 py-0.5">?token=你的工作区Token</code>，
          或回到入口页填写 workspace 名称和 token/password。
        </p>
        <a
          href="/"
          className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          返回 Workspace 入口
        </a>
      </div>
    );
  }

  return (
    <WorkspaceProvider workspaceId={workspaceId} token={token}>
      <IdentityGate>
        <LayoutProvider>
          <Wrapper />
        </LayoutProvider>
      </IdentityGate>
    </WorkspaceProvider>
  );
}

export default function WorkspacePage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = use(params);

  return (
    <Suspense fallback={<WorkspaceLoadingSplash />}>
      <WorkspaceContent workspaceId={workspaceId} />
    </Suspense>
  );
}
