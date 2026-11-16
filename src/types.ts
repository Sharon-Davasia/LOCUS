export type MemoryKind =
  | 'decision'
  | 'dead_end'
  | 'research'
  | 'convention'
  | 'note';

export type MemoryStatus = 'active' | 'superseded' | 'archived';

export type SourceIde =
  | 'cursor'
  | 'claude-code'
  | 'windsurf'
  | 'codex'
  | 'cli'
  | 'ui'
  | 'mcp'
  | 'git';

export type TaskStatus = 'done' | 'in_progress' | 'todo' | 'blocked';

export interface TaskStep {
  id: string;
  text: string;
  status: TaskStatus;
  files?: string[];
}

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  gitCommonDir: string | null;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
}

export interface BranchHandoff {
  id: string;
  projectId: string;
  branch: string;
  worktreePath: string;
  objective: string;
  summary: string;
  activeHypothesis: string;
  tasks: TaskStep[];
  blockers: string[];
  nextSteps: string[];
  activeFiles: string[];
  headSha: string | null;
  dirtySignature: string | null;
  lastIde: SourceIde;
  updatedAt: string;
}

export interface MemoryEntry {
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
  status: MemoryStatus;
  supersededBy: string | null;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DriftStatus {
  drifted: boolean;
  changedFiles: string[];
  missingFiles: string[];
  reason?: string;
}

export interface MemoryWithDrift extends MemoryEntry {
  drift: DriftStatus;
}

export interface SearchOptions {
  projectId: string;
  query: string;
  kinds?: MemoryKind[];
  tags?: string[];
  branch?: string;
  activeFiles?: string[];
  includeArchived?: boolean;
  limit?: number;
}

export interface SearchResult extends MemoryWithDrift {
  score: number;
  bm25Score: number;
  semanticScore: number;
  recencyScore: number;
  contextBoost: number;
  snippet: string;
}

export type TimelineEventType =
  | 'init'
  | 'checkpoint'
  | 'memory_recorded'
  | 'memory_updated'
  | 'session_harvested'
  | 'ide_switch'
  | 'bridge_compiled';

export interface TimelineEvent {
  id: string;
  projectId: string;
  branch: string | null;
  sourceIde: SourceIde;
  eventType: TimelineEventType;
  summary: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface GitFileChange {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';
  staged: boolean;
}

export interface GitCommitSummary {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  timestamp: string;
}

export interface GitRepoState {
  isGitRepo: boolean;
  repoRoot: string;
  gitDir: string | null;
  gitCommonDir: string | null;
  branch: string;
  headSha: string | null;
  shortSha: string | null;
  dirtyFiles: GitFileChange[];
  diffStat: string;
  recentCommits: GitCommitSummary[];
  dirtySignature: string;
}

export interface CheckpointInput {
  projectPath?: string;
  branch?: string;
  objective?: string;
  summary?: string;
  activeHypothesis?: string;
  tasks?: Array<{
    id?: string;
    text: string;
    status: TaskStatus;
    files?: string[];
  }>;
  blockers?: string[];
  nextSteps?: string[];
  activeFiles?: string[];
  sourceIde?: SourceIde;
  mergeTasks?: boolean;
}

export interface RecordMemoryInput {
  projectPath?: string;
  branch?: string | null;
  kind: MemoryKind;
  title: string;
  summary?: string;
  body: string;
  tags?: string[];
  relatedFiles?: string[];
  sourceUrls?: string[];
  sourceIde?: SourceIde;
  pinned?: boolean;
  supersedesId?: string;
}

export interface TokenBudgetReport {
  totalBudget: number;
  usedTokens: number;
  utilizationPct: number;
  sections: {
    handoff: number;
    gitState: number;
    deadEnds: number;
    decisions: number;
    conventions: number;
    researchIndex: number;
    mcpGuide: number;
  };
  omittedCount: number;
}

export interface CompiledContext {
  markdown: string;
  cursorMdc: string;
  clipboardBriefing: string;
  tokenReport: TokenBudgetReport;
  compiledAt: string;
}
