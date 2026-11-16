export type MemoryKind =
  | 'decision'
  | 'dead_end'
  | 'research'
  | 'convention'
  | 'note';

export type TaskStatus = 'done' | 'in_progress' | 'todo' | 'blocked';

export type SourceIde =
  | 'cursor'
  | 'claude-code'
  | 'windsurf'
  | 'codex'
  | 'cli'
  | 'ui'
  | 'mcp'
  | 'git';

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  defaultBranch: string;
  updatedAt: string;
}

export interface TaskStep {
  id?: string;
  text: string;
  status: TaskStatus;
  files?: string[];
}

export interface BranchHandoff {
  id: string;
  projectId: string;
  branch: string;
  objective: string;
  summary: string;
  activeHypothesis: string;
  tasks: TaskStep[];
  blockers: string[];
  nextSteps: string[];
  activeFiles: string[];
  headSha: string | null;
  lastIde: SourceIde;
  updatedAt: string;
}

export interface MemoryItem {
  id: string;
  projectId: string;
  branch: string | null;
  kind: MemoryKind;
  title: string;
  summary: string;
  body: string;
  tags: string[];
  relatedFiles: string[];
  sourceUrls: string[];
  anchorCommit: string | null;
  sourceIde: SourceIde;
  pinned: boolean;
  updatedAt: string;
  score?: number;
  snippet?: string;
  drift: {
    drifted: boolean;
    changedFiles: string[];
    missingFiles: string[];
    reason?: string;
  };
}

export interface TimelineEvent {
  id: string;
  branch: string | null;
  sourceIde: SourceIde;
  eventType: string;
  summary: string;
  createdAt: string;
}

export interface ProjectOverview {
  project: Project;
  git: {
    isGitRepo: boolean;
    repoRoot: string;
    branch: string;
    shortSha: string | null;
    dirtyFiles: Array<{ path: string; status: string; staged: boolean }>;
  };
  handoff: BranchHandoff;
  handoffs: BranchHandoff[];
  stats: {
    totalMemories: number;
    byKind: Record<MemoryKind, number>;
    driftedCount: number;
    branchesCount: number;
    eventsCount: number;
    byIde: Record<string, number>;
  };
  compiled: {
    markdown: string;
    cursorMdc: string;
    clipboardBriefing: string;
    tokenReport: {
      totalBudget: number;
      usedTokens: number;
      utilizationPct: number;
      sections: Record<string, number>;
      omittedCount: number;
    };
  };
  bridgeHealth: {
    initialized: boolean;
    files: Array<{ path: string; exists: boolean; sizeBytes: number }>;
  };
  timeline: TimelineEvent[];
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data as T;
}

export const locusApi = {
  listProjects: () =>
    requestJson<{ defaultProjectId: string; projects: Project[] }>('/api/projects'),

  getOverview: (projectId: string, branch?: string) =>
    requestJson<ProjectOverview>(
      `/api/projects/${encodeURIComponent(projectId)}/overview${
        branch ? `?branch=${encodeURIComponent(branch)}` : ''
      }`,
    ),

  saveHandoff: (
    projectId: string,
    payload: {
      branch?: string;
      objective: string;
      summary: string;
      activeHypothesis: string;
      tasks: TaskStep[];
      blockers: string[];
      nextSteps: string[];
      sourceIde: SourceIde;
    },
  ) =>
    requestJson<{ ok: boolean; handoff: BranchHandoff }>(
      `/api/projects/${encodeURIComponent(projectId)}/handoff`,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
    ),

  updateTaskStatus: (
    projectId: string,
    taskIdOrQuery: string,
    status: TaskStatus,
    branch?: string,
  ) =>
    requestJson<{ ok: boolean; handoff: BranchHandoff }>(
      `/api/projects/${encodeURIComponent(projectId)}/handoff/tasks`,
      {
        method: 'PATCH',
        body: JSON.stringify({ taskIdOrQuery, status, branch, sourceIde: 'ui' }),
      },
    ),

  queryMemories: (
    projectId: string,
    params: { q?: string; kind?: string } = {},
  ) => {
    const sp = new URLSearchParams();
    if (params.q) sp.set('q', params.q);
    if (params.kind && params.kind !== 'all') sp.set('kind', params.kind);
    const qs = sp.toString();
    return requestJson<{ mode: string; count: number; memories: MemoryItem[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/memories${qs ? `?${qs}` : ''}`,
    );
  },

  recordMemory: (
    projectId: string,
    payload: {
      kind: MemoryKind;
      title: string;
      body: string;
      tags: string[];
      relatedFiles: string[];
      sourceUrls: string[];
      pinned: boolean;
      sourceIde: SourceIde;
    },
  ) =>
    requestJson<{ ok: boolean; memory: MemoryItem }>(
      `/api/projects/${encodeURIComponent(projectId)}/memories`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    ),

  patchMemory: (
    memoryId: string,
    patch: Partial<{ pinned: boolean; reanchorCommit: boolean; status: string }>,
  ) =>
    requestJson<{ ok: boolean; memory: MemoryItem }>(
      `/api/memories/${encodeURIComponent(memoryId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(patch),
      },
    ),

  deleteMemory: (memoryId: string) =>
    requestJson<{ ok: boolean }>(`/api/memories/${encodeURIComponent(memoryId)}`, {
      method: 'DELETE',
    }),

  syncProject: (projectId: string) =>
    requestJson<{
      ok: boolean;
      harvestedCount: number;
      writtenFiles: string[];
    }>(`/api/projects/${encodeURIComponent(projectId)}/sync`, {
      method: 'POST',
    }),

  initProject: (projectId: string) =>
    requestJson<{ ok: boolean; writtenFiles: string[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/init`,
      { method: 'POST', body: JSON.stringify({}) },
    ),
};
