import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowRightLeft,
  BookOpen,
  Check,
  CheckCircle2,
  Circle,
  Clock,
  Compass,
  Copy,
  Cpu,
  FileCode2,
  FolderGit2,
  GitBranch,
  Layers,
  Pin,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  Terminal,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import {
  locusApi,
  type MemoryItem,
  type MemoryKind,
  type Project,
  type ProjectOverview,
  type SourceIde,
  type TaskStatus,
  type TaskStep,
} from './api';

type ActiveTab = 'handoff' | 'guardrails' | 'vault' | 'bridges' | 'timeline';

const IDE_BADGE_STYLES: Record<string, string> = {
  cursor: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  'claude-code': 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  windsurf: 'bg-teal-500/15 text-teal-300 border-teal-500/30',
  codex: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  mcp: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30',
  cli: 'bg-zinc-500/15 text-zinc-300 border-zinc-500/30',
  ui: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
};

const KIND_META: Record<
  MemoryKind,
  { label: string; badge: string; border: string }
> = {
  dead_end: {
    label: 'Dead End',
    badge: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
    border: 'border-rose-500/25 hover:border-rose-500/45',
  },
  decision: {
    label: 'Decision',
    badge: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30',
    border: 'border-indigo-500/25 hover:border-indigo-500/45',
  },
  research: {
    label: 'Research',
    badge: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    border: 'border-emerald-500/25 hover:border-emerald-500/45',
  },
  convention: {
    label: 'Convention',
    badge: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    border: 'border-amber-500/25 hover:border-amber-500/45',
  },
  note: {
    label: 'Note',
    badge: 'bg-zinc-500/15 text-zinc-300 border-zinc-500/30',
    border: 'border-zinc-800 hover:border-zinc-700',
  },
};

function nextTaskStatus(current: TaskStatus): TaskStatus {
  const order: TaskStatus[] = ['todo', 'in_progress', 'done', 'blocked'];
  return order[(order.indexOf(current) + 1) % order.length];
}

function formatRelativeTime(iso: string): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [overview, setOverview] = useState<ProjectOverview | null>(null);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [activeTab, setActiveTab] = useState<ActiveTab>('handoff');

  const [searchQuery, setSearchQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<string>('all');
  const [expandedMemoryId, setExpandedMemoryId] = useState<string | null>(null);
  const [bridgePreviewMode, setBridgePreviewMode] = useState<
    'markdown' | 'cursor' | 'briefing'
  >('markdown');

  // Handoff editor state
  const [objDraft, setObjDraft] = useState('');
  const [sumDraft, setSumDraft] = useState('');
  const [hypDraft, setHypDraft] = useState('');
  const [tasksDraft, setTasksDraft] = useState<TaskStep[]>([]);
  const [newTaskText, setNewTaskText] = useState('');
  const [blockersDraft, setBlockersDraft] = useState('');
  const [nextStepsDraft, setNextStepsDraft] = useState('');
  const [ideDraft, setIdeDraft] = useState<SourceIde>('cursor');
  const [handoffDirty, setHandoffDirty] = useState(false);

  // Record memory modal state
  const [showRecordModal, setShowRecordModal] = useState(false);
  const [memKind, setMemKind] = useState<MemoryKind>('research');
  const [memTitle, setMemTitle] = useState('');
  const [memBody, setMemBody] = useState('');
  const [memTags, setMemTags] = useState('');
  const [memFiles, setMemFiles] = useState('');
  const [memUrls, setMemUrls] = useState('');
  const [memIde, setMemIde] = useState<SourceIde>('cursor');
  const [memPinned, setMemPinned] = useState(false);

  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => {
      setToast((prev) => (prev === msg ? null : prev));
    }, 3400);
  }, []);

  const hydrateDraftFromOverview = useCallback((ov: ProjectOverview) => {
    setObjDraft(ov.handoff.objective);
    setSumDraft(ov.handoff.summary);
    setHypDraft(ov.handoff.activeHypothesis);
    setTasksDraft(ov.handoff.tasks);
    setBlockersDraft(ov.handoff.blockers.join('\n'));
    setNextStepsDraft(ov.handoff.nextSteps.join('\n'));
    setIdeDraft(
      ov.handoff.lastIde === 'cli' || ov.handoff.lastIde === 'ui'
        ? 'cursor'
        : ov.handoff.lastIde,
    );
    setHandoffDirty(false);
  }, []);

  const loadProjectData = useCallback(
    async (projectId: string, preserveDraft = false) => {
      if (!projectId) return;
      const [ov, memRes] = await Promise.all([
        locusApi.getOverview(projectId),
        locusApi.queryMemories(projectId, {
          q: searchQuery,
          kind: kindFilter,
        }),
      ]);
      setOverview(ov);
      setMemories(memRes.memories);
      if (!preserveDraft) {
        hydrateDraftFromOverview(ov);
      }
    },
    [hydrateDraftFromOverview, kindFilter, searchQuery],
  );

  useEffect(() => {
    locusApi
      .listProjects()
      .then((res) => {
        setProjects(res.projects);
        const initialId = res.defaultProjectId || res.projects[0]?.id || '';
        setSelectedProjectId(initialId);
      })
      .catch((err) => notify(err.message));
  }, [notify]);

  useEffect(() => {
    if (selectedProjectId) {
      loadProjectData(selectedProjectId, false).catch((err) => notify(err.message));
    }
  }, [selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) return;
    locusApi
      .queryMemories(selectedProjectId, { q: searchQuery, kind: kindFilter })
      .then((res) => setMemories(res.memories))
      .catch((err) => notify(err.message));
  }, [selectedProjectId, searchQuery, kindFilter, notify]);

  const handleSaveHandoff = async () => {
    if (!selectedProjectId) return;
    setBusy(true);
    try {
      await locusApi.saveHandoff(selectedProjectId, {
        objective: objDraft,
        summary: sumDraft,
        activeHypothesis: hypDraft,
        tasks: tasksDraft,
        blockers: blockersDraft
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        nextSteps: nextStepsDraft
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        sourceIde: ideDraft,
      });
      await loadProjectData(selectedProjectId, false);
      notify('Handoff capsule saved & IDE bridges recompiled');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to save handoff');
    } finally {
      setBusy(false);
    }
  };

  const handleAddTask = () => {
    const trimmed = newTaskText.trim();
    if (!trimmed) return;
    setTasksDraft((prev) => [...prev, { text: trimmed, status: 'todo' }]);
    setNewTaskText('');
    setHandoffDirty(true);
  };

  const handleSync = async () => {
    if (!selectedProjectId) return;
    setBusy(true);
    try {
      const res = await locusApi.syncProject(selectedProjectId);
      await loadProjectData(selectedProjectId, false);
      notify(
        res.harvestedCount > 0
          ? `Harvested ${res.harvestedCount} IDE session(s) & refreshed bridges`
          : 'Synced git state & refreshed IDE bridge files',
      );
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setBusy(false);
    }
  };

  const handleInitBridges = async () => {
    if (!selectedProjectId) return;
    setBusy(true);
    try {
      const res = await locusApi.initProject(selectedProjectId);
      await loadProjectData(selectedProjectId, true);
      notify(`Initialized ${res.writtenFiles.length} IDE bridge & MCP config files`);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Bridge initialization failed');
    } finally {
      setBusy(false);
    }
  };

  const handleCopyBriefing = async () => {
    if (!overview) return;
    const text =
      bridgePreviewMode === 'cursor'
        ? overview.compiled.cursorMdc
        : bridgePreviewMode === 'markdown'
          ? overview.compiled.markdown
          : overview.compiled.clipboardBriefing;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    notify('Copied handoff briefing to clipboard');
    setTimeout(() => setCopied(false), 1800);
  };

  const handleCreateMemory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProjectId || !memTitle.trim() || !memBody.trim()) return;
    setBusy(true);
    try {
      await locusApi.recordMemory(selectedProjectId, {
        kind: memKind,
        title: memTitle.trim(),
        body: memBody.trim(),
        tags: memTags
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        relatedFiles: memFiles
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        sourceUrls: memUrls
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        pinned: memPinned,
        sourceIde: memIde,
      });
      setShowRecordModal(false);
      setMemTitle('');
      setMemBody('');
      setMemTags('');
      setMemFiles('');
      setMemUrls('');
      setMemPinned(false);
      await loadProjectData(selectedProjectId, true);
      notify(`Recorded ${KIND_META[memKind].label} to Locus`);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to record memory');
    } finally {
      setBusy(false);
    }
  };

  const handleReanchor = async (memoryId: string) => {
    if (!selectedProjectId) return;
    await locusApi.patchMemory(memoryId, { reanchorCommit: true });
    await loadProjectData(selectedProjectId, true);
    notify('Memory verified & anchored to current HEAD commit');
  };

  const handleTogglePin = async (item: MemoryItem) => {
    if (!selectedProjectId) return;
    await locusApi.patchMemory(item.id, { pinned: !item.pinned });
    await loadProjectData(selectedProjectId, true);
  };

  const handleDeleteMemory = async (memoryId: string) => {
    if (!selectedProjectId) return;
    await locusApi.deleteMemory(memoryId);
    await loadProjectData(selectedProjectId, true);
    notify('Memory removed');
  };

  const guardrails = useMemo(() => {
    const deadEnds = memories.filter((m) => m.kind === 'dead_end');
    const decisions = memories.filter((m) => m.kind === 'decision');
    return { deadEnds, decisions };
  }, [memories]);

  const tokenSections = useMemo(() => {
    if (!overview) return [];
    const s = overview.compiled.tokenReport.sections;
    return [
      { label: 'Handoff Capsule', tokens: s.handoff ?? 0, color: 'bg-indigo-500' },
      { label: 'Dead Ends', tokens: s.deadEnds ?? 0, color: 'bg-rose-500' },
      { label: 'Key Decisions', tokens: s.decisions ?? 0, color: 'bg-sky-500' },
      { label: 'Live Git State', tokens: s.gitState ?? 0, color: 'bg-emerald-500' },
      { label: 'Research Index', tokens: s.researchIndex ?? 0, color: 'bg-amber-500' },
      { label: 'Conventions & MCP', tokens: (s.conventions ?? 0) + (s.mcpGuide ?? 0), color: 'bg-violet-500' },
    ];
  }, [overview]);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      {/* Top Toast */}
      {toast && (
        <div className="fixed bottom-5 right-5 z-50 flex items-center gap-2.5 px-4 py-2.5 rounded-lg bg-zinc-900 border border-indigo-500/40 text-sm text-zinc-100 shadow-2xl">
          <Sparkles className="w-4 h-4 text-indigo-400 shrink-0" />
          <span>{toast}</span>
        </div>
      )}

      {/* Header */}
      <header className="border-b border-zinc-800/80 bg-zinc-950/90 backdrop-blur sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3.5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3.5">
            <div className="w-9 h-9 rounded-lg bg-indigo-500/15 border border-indigo-500/35 flex items-center justify-center">
              <Compass className="w-5 h-5 text-indigo-400" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-semibold tracking-tight text-base text-white">
                  LOCUS
                </span>
                <span className="text-[11px] font-mono uppercase px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-400">
                  Memory Palace
                </span>
              </div>
              <p className="text-xs text-zinc-400 hidden sm:block">
                Local Cross-IDE Context Engine · Cursor ↔ Claude Code ↔ Windsurf ↔ Codex
              </p>
            </div>

            {projects.length > 0 && (
              <div className="ml-2 flex items-center gap-2 bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5">
                <FolderGit2 className="w-3.5 h-3.5 text-zinc-400" />
                <select
                  value={selectedProjectId}
                  onChange={(e) => setSelectedProjectId(e.target.value)}
                  className="bg-transparent text-xs font-medium text-zinc-100 focus:outline-none"
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id} className="bg-zinc-900">
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {overview && (
              <div className="hidden lg:flex items-center gap-2 text-xs font-mono text-zinc-400">
                <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-zinc-900 border border-zinc-800 text-zinc-300">
                  <GitBranch className="w-3.5 h-3.5 text-emerald-400" />
                  {overview.git.branch}
                  {overview.git.shortSha && (
                    <span className="text-zinc-500">@{overview.git.shortSha}</span>
                  )}
                </span>
                <span
                  className={`inline-flex items-center gap-1 px-2 py-1 rounded border ${
                    IDE_BADGE_STYLES[overview.handoff.lastIde] ?? IDE_BADGE_STYLES.cli
                  }`}
                >
                  <ArrowRightLeft className="w-3 h-3" />
                  Last: {overview.handoff.lastIde}
                </span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleSync}
              disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-200 transition cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
              Sync Sessions
            </button>

            <button
              onClick={handleCopyBriefing}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-200 transition cursor-pointer"
            >
              {copied ? (
                <Check className="w-3.5 h-3.5 text-emerald-400" />
              ) : (
                <Copy className="w-3.5 h-3.5 text-zinc-400" />
              )}
              Copy Briefing
            </button>

            <button
              onClick={() => {
                setKindFilter('all');
                setShowRecordModal(true);
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-indigo-600 hover:bg-indigo-500 text-white transition cursor-pointer shadow-sm"
            >
              <Plus className="w-3.5 h-3.5" />
              Record Memory
            </button>
          </div>
        </div>

        {/* Sub-navigation */}
        <div className="max-w-7xl mx-auto px-4 sm:px-6 flex items-center gap-1 overflow-x-auto">
          {[
            { id: 'handoff', label: 'Handoff Capsule', icon: Layers },
            {
              id: 'guardrails',
              label: `Decisions & Dead Ends (${
                (overview?.stats.byKind.decision ?? 0) +
                (overview?.stats.byKind.dead_end ?? 0)
              })`,
              icon: ShieldAlert,
            },
            {
              id: 'vault',
              label: `Research Vault & Search (${overview?.stats.totalMemories ?? 0})`,
              icon: BookOpen,
            },
            { id: 'bridges', label: 'IDE Bridges & Preview', icon: Cpu },
            {
              id: 'timeline',
              label: `Cross-IDE Timeline (${overview?.stats.eventsCount ?? 0})`,
              icon: Activity,
            },
          ].map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => {
                  setActiveTab(tab.id as ActiveTab);
                  if (tab.id === 'guardrails' && kindFilter !== 'all') {
                    setKindFilter('all');
                  }
                }}
                className={`inline-flex items-center gap-2 px-3.5 py-2.5 text-xs font-medium border-b-2 transition whitespace-nowrap cursor-pointer ${
                  isActive
                    ? 'border-indigo-500 text-white'
                    : 'border-transparent text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {tab.label}
              </button>
            );
          })}
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 flex-1">
        {!overview ? (
          <div className="py-20 text-center text-zinc-500 text-sm">
            Loading Locus project memory space…
          </div>
        ) : (
          <>
            {/* Top KPI Strip */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
              <div className="p-3.5 rounded-xl bg-zinc-900/70 border border-zinc-800/80">
                <div className="text-[11px] uppercase tracking-wider text-zinc-400">
                  Capsule Budget
                </div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-xl font-semibold font-mono text-white">
                    {overview.compiled.tokenReport.usedTokens}
                  </span>
                  <span className="text-xs font-mono text-zinc-500">
                    / {overview.compiled.tokenReport.totalBudget} tok (
                    {overview.compiled.tokenReport.utilizationPct}%)
                  </span>
                </div>
              </div>

              <div className="p-3.5 rounded-xl bg-zinc-900/70 border border-zinc-800/80">
                <div className="text-[11px] uppercase tracking-wider text-zinc-400">
                  Structured Memories
                </div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-xl font-semibold font-mono text-white">
                    {overview.stats.totalMemories}
                  </span>
                  <span className="text-xs text-zinc-400">
                    {overview.stats.byKind.dead_end} dead ends ·{' '}
                    {overview.stats.byKind.research} research
                  </span>
                </div>
              </div>

              <div className="p-3.5 rounded-xl bg-zinc-900/70 border border-zinc-800/80">
                <div className="text-[11px] uppercase tracking-wider text-zinc-400">
                  Git Drift Guard
                </div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span
                    className={`text-xl font-semibold font-mono ${
                      overview.stats.driftedCount > 0
                        ? 'text-amber-400'
                        : 'text-emerald-400'
                    }`}
                  >
                    {overview.stats.driftedCount === 0
                      ? '0 Drifted'
                      : `${overview.stats.driftedCount} Flagged`}
                  </span>
                  <span className="text-xs text-zinc-400">
                    {overview.git.dirtyFiles.length} dirty file(s)
                  </span>
                </div>
              </div>

              <div className="p-3.5 rounded-xl bg-zinc-900/70 border border-zinc-800/80">
                <div className="text-[11px] uppercase tracking-wider text-zinc-400">
                  IDE Bridge Status
                </div>
                <div className="mt-1 flex items-center justify-between">
                  <span
                    className={`text-sm font-medium ${
                      overview.bridgeHealth.initialized
                        ? 'text-emerald-400'
                        : 'text-amber-400'
                    }`}
                  >
                    {overview.bridgeHealth.initialized
                      ? 'Active & Git-Clean'
                      : 'Not Initialized'}
                  </span>
                  {!overview.bridgeHealth.initialized && (
                    <button
                      onClick={handleInitBridges}
                      className="text-xs px-2 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white cursor-pointer"
                    >
                      Init Now
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* TAB 1: HANDOFF CAPSULE */}
            {activeTab === 'handoff' && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="lg:col-span-2 space-y-5">
                  <div className="p-5 rounded-xl bg-zinc-900/70 border border-zinc-800 space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h2 className="text-sm font-semibold text-white">
                          Active Branch Handoff Capsule ({overview.git.branch})
                        </h2>
                        <p className="text-xs text-zinc-400">
                          Auto-compiled into Cursor rules, Claude Code{' '}
                          <code className="text-zinc-300">@.locus/HANDOFF.md</code>, and
                          MCP resources.
                        </p>
                      </div>

                      <div className="flex items-center gap-2">
                        <select
                          value={ideDraft}
                          onChange={(e) => {
                            setIdeDraft(e.target.value as SourceIde);
                            setHandoffDirty(true);
                          }}
                          className="bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-xs text-zinc-200"
                        >
                          <option value="cursor">Source: Cursor</option>
                          <option value="claude-code">Source: Claude Code</option>
                          <option value="windsurf">Source: Windsurf</option>
                          <option value="codex">Source: Codex</option>
                        </select>

                        <button
                          onClick={handleSaveHandoff}
                          disabled={busy}
                          className={`px-3.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
                            handoffDirty
                              ? 'bg-indigo-600 hover:bg-indigo-500 text-white'
                              : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-200'
                          }`}
                        >
                          Save Checkpoint
                        </button>
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-zinc-400 mb-1">
                        Current Objective ("Where was I?")
                      </label>
                      <input
                        type="text"
                        value={objDraft}
                        onChange={(e) => {
                          setObjDraft(e.target.value);
                          setHandoffDirty(true);
                        }}
                        placeholder="e.g. Finish WebRTC retry state machine & verify Node 22 compatibility"
                        className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500"
                      />
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs font-medium text-zinc-400 mb-1">
                          Working State Summary
                        </label>
                        <textarea
                          rows={3}
                          value={sumDraft}
                          onChange={(e) => {
                            setSumDraft(e.target.value);
                            setHandoffDirty(true);
                          }}
                          placeholder="Why uncommitted files look the way they do right now…"
                          className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500"
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-zinc-400 mb-1">
                          Active Hypothesis / Design Direction
                        </label>
                        <textarea
                          rows={3}
                          value={hypDraft}
                          onChange={(e) => {
                            setHypDraft(e.target.value);
                            setHandoffDirty(true);
                          }}
                          placeholder="Current technical approach being validated…"
                          className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500"
                        />
                      </div>
                    </div>

                    {/* Task Checklist */}
                    <div>
                      <label className="block text-xs font-medium text-zinc-400 mb-2">
                        Step Checklist (click status icon to cycle: todo → in_progress → done → blocked)
                      </label>

                      <div className="space-y-1.5 mb-2.5">
                        {tasksDraft.length === 0 ? (
                          <div className="text-xs text-zinc-500 py-2 px-3 rounded-lg bg-zinc-950/60 border border-zinc-800/60">
                            No checklist steps yet. Add steps below or call{' '}
                            <code>locus_checkpoint</code> from Cursor / Claude Code.
                          </div>
                        ) : (
                          tasksDraft.map((t, idx) => (
                            <div
                              key={t.id ?? idx}
                              className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800/80"
                            >
                              <button
                                type="button"
                                onClick={() => {
                                  const updated = [...tasksDraft];
                                  updated[idx] = {
                                    ...t,
                                    status: nextTaskStatus(t.status),
                                  };
                                  setTasksDraft(updated);
                                  setHandoffDirty(true);
                                }}
                                className="flex items-center gap-2.5 text-left flex-1 cursor-pointer"
                              >
                                {t.status === 'done' ? (
                                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                                ) : t.status === 'in_progress' ? (
                                  <Clock className="w-4 h-4 text-indigo-400 shrink-0" />
                                ) : t.status === 'blocked' ? (
                                  <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                                ) : (
                                  <Circle className="w-4 h-4 text-zinc-500 shrink-0" />
                                )}
                                <span
                                  className={`text-xs ${
                                    t.status === 'done'
                                      ? 'line-through text-zinc-500'
                                      : 'text-zinc-200'
                                  }`}
                                >
                                  {t.text}
                                </span>
                                <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-zinc-900 text-zinc-400">
                                  {t.status}
                                </span>
                              </button>

                              <button
                                type="button"
                                onClick={() => {
                                  setTasksDraft(tasksDraft.filter((_, i) => i !== idx));
                                  setHandoffDirty(true);
                                }}
                                className="text-zinc-500 hover:text-rose-400 p-1 cursor-pointer"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ))
                        )}
                      </div>

                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={newTaskText}
                          onChange={(e) => setNewTaskText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              handleAddTask();
                            }
                          }}
                          placeholder="Add a task step…"
                          className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500"
                        />
                        <button
                          type="button"
                          onClick={handleAddTask}
                          className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-200 cursor-pointer"
                        >
                          Add Step
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs font-medium text-zinc-400 mb-1">
                          Immediate Next Steps (one per line)
                        </label>
                        <textarea
                          rows={3}
                          value={nextStepsDraft}
                          onChange={(e) => {
                            setNextStepsDraft(e.target.value);
                            setHandoffDirty(true);
                          }}
                          placeholder="Next concrete actions for incoming IDE…"
                          className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500"
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-zinc-400 mb-1">
                          Active Blockers (one per line)
                        </label>
                        <textarea
                          rows={3}
                          value={blockersDraft}
                          onChange={(e) => {
                            setBlockersDraft(e.target.value);
                            setHandoffDirty(true);
                          }}
                          placeholder="Unresolved test failures or open questions…"
                          className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500"
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Right Sidebar: Token Budget + Live Git Dirty State */}
                <div className="space-y-5">
                  <div className="p-5 rounded-xl bg-zinc-900/70 border border-zinc-800 space-y-3.5">
                    <div className="flex items-center justify-between">
                      <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
                        Token Budget Allocation
                      </h3>
                      <span className="text-xs font-mono text-indigo-400">
                        {overview.compiled.tokenReport.usedTokens} /{' '}
                        {overview.compiled.tokenReport.totalBudget} tok
                      </span>
                    </div>

                    <div className="w-full h-2.5 rounded-full bg-zinc-950 border border-zinc-800 overflow-hidden flex">
                      {tokenSections.map((sec) => {
                        const widthPct = Math.min(
                          100,
                          (sec.tokens / overview.compiled.tokenReport.totalBudget) * 100,
                        );
                        if (widthPct <= 0) return null;
                        return (
                          <div
                            key={sec.label}
                            style={{ width: `${widthPct}%` }}
                            className={`${sec.color} h-full`}
                            title={`${sec.label}: ${sec.tokens} tokens`}
                          />
                        );
                      })}
                    </div>

                    <div className="space-y-1.5 pt-1">
                      {tokenSections.map((sec) => (
                        <div
                          key={sec.label}
                          className="flex items-center justify-between text-xs"
                        >
                          <div className="flex items-center gap-2 text-zinc-400">
                            <span className={`w-2 h-2 rounded-full ${sec.color}`} />
                            <span>{sec.label}</span>
                          </div>
                          <span className="font-mono text-zinc-300">
                            {sec.tokens} tok
                          </span>
                        </div>
                      ))}
                    </div>

                    {overview.compiled.tokenReport.omittedCount > 0 && (
                      <p className="text-[11px] text-zinc-400 pt-2 border-t border-zinc-800">
                        +{overview.compiled.tokenReport.omittedCount} deeper memories
                        preserved via progressive disclosure (<code>locus_search</code>).
                      </p>
                    )}
                  </div>

                  <div className="p-5 rounded-xl bg-zinc-900/70 border border-zinc-800 space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
                        Live Git Working Tree
                      </h3>
                      <span className="text-xs font-mono text-zinc-400">
                        {overview.git.dirtyFiles.length} uncommitted
                      </span>
                    </div>

                    {overview.git.dirtyFiles.length === 0 ? (
                      <p className="text-xs text-emerald-400/90 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">
                        Working tree is clean (all Locus bridge files hidden via{' '}
                        <code>.git/info/exclude</code>).
                      </p>
                    ) : (
                      <div className="space-y-1.5 max-h-56 overflow-y-auto">
                        {overview.git.dirtyFiles.map((f) => (
                          <div
                            key={f.path}
                            className="flex items-center justify-between text-xs font-mono px-2.5 py-1.5 rounded bg-zinc-950 border border-zinc-800/80"
                          >
                            <span className="text-zinc-200 truncate">{f.path}</span>
                            <span className="text-[10px] uppercase text-amber-400 ml-2 shrink-0">
                              {f.status}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* TAB 2: DECISIONS & DEAD ENDS */}
            {activeTab === 'guardrails' && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Dead Ends Column */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-rose-300 flex items-center gap-2">
                      <ShieldAlert className="w-4 h-4 text-rose-400" />
                      Dead Ends — Do Not Retry ({guardrails.deadEnds.length})
                    </h2>
                    <button
                      onClick={() => {
                        setMemKind('dead_end');
                        setShowRecordModal(true);
                      }}
                      className="text-xs text-rose-300 hover:text-rose-200 cursor-pointer"
                    >
                      + Log Dead End
                    </button>
                  </div>

                  {guardrails.deadEnds.length === 0 ? (
                    <div className="p-6 rounded-xl bg-zinc-900/50 border border-zinc-800 text-xs text-zinc-500">
                      No dead ends recorded yet. Logging failed libraries or approaches
                      stops incoming IDEs from repeating costly mistakes.
                    </div>
                  ) : (
                    guardrails.deadEnds.map((item) => (
                      <MemoryCard
                        key={item.id}
                        item={item}
                        expanded={expandedMemoryId === item.id}
                        onToggleExpand={() =>
                          setExpandedMemoryId(
                            expandedMemoryId === item.id ? null : item.id,
                          )
                        }
                        onReanchor={() => handleReanchor(item.id)}
                        onTogglePin={() => handleTogglePin(item)}
                        onDelete={() => handleDeleteMemory(item.id)}
                      />
                    ))
                  )}
                </div>

                {/* Decisions Column */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-indigo-300 flex items-center gap-2">
                      <Compass className="w-4 h-4 text-indigo-400" />
                      Architectural Decisions ({guardrails.decisions.length})
                    </h2>
                    <button
                      onClick={() => {
                        setMemKind('decision');
                        setShowRecordModal(true);
                      }}
                      className="text-xs text-indigo-300 hover:text-indigo-200 cursor-pointer"
                    >
                      + Log Decision
                    </button>
                  </div>

                  {guardrails.decisions.length === 0 ? (
                    <div className="p-6 rounded-xl bg-zinc-900/50 border border-zinc-800 text-xs text-zinc-500">
                      No architectural decisions recorded yet.
                    </div>
                  ) : (
                    guardrails.decisions.map((item) => (
                      <MemoryCard
                        key={item.id}
                        item={item}
                        expanded={expandedMemoryId === item.id}
                        onToggleExpand={() =>
                          setExpandedMemoryId(
                            expandedMemoryId === item.id ? null : item.id,
                          )
                        }
                        onReanchor={() => handleReanchor(item.id)}
                        onTogglePin={() => handleTogglePin(item)}
                        onDelete={() => handleDeleteMemory(item.id)}
                      />
                    ))
                  )}
                </div>
              </div>
            )}

            {/* TAB 3: RESEARCH VAULT & HYBRID SEARCH */}
            {activeTab === 'vault' && (
              <div className="space-y-4">
                <div className="flex flex-col sm:flex-row gap-3">
                  <div className="relative flex-1">
                    <Search className="w-4 h-4 text-zinc-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Hybrid search (FTS5 BM25 + semantic vectors + file paths)…"
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-xl pl-10 pr-4 py-2.5 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500"
                    />
                  </div>

                  <div className="flex items-center gap-1.5 overflow-x-auto">
                    {(
                      [
                        ['all', 'All'],
                        ['research', 'Research'],
                        ['dead_end', 'Dead Ends'],
                        ['decision', 'Decisions'],
                        ['convention', 'Conventions'],
                        ['note', 'Notes'],
                      ] as const
                    ).map(([k, label]) => (
                      <button
                        key={k}
                        onClick={() => setKindFilter(k)}
                        className={`px-3 py-2 rounded-lg text-xs font-medium transition whitespace-nowrap cursor-pointer ${
                          kindFilter === k
                            ? 'bg-indigo-600 text-white'
                            : 'bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-zinc-200'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {memories.length === 0 ? (
                  <div className="p-10 text-center rounded-xl bg-zinc-900/50 border border-zinc-800 text-sm text-zinc-500">
                    No matching memories found. Try another search query or record a new
                    research note.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {memories.map((item) => (
                      <MemoryCard
                        key={item.id}
                        item={item}
                        expanded={expandedMemoryId === item.id}
                        onToggleExpand={() =>
                          setExpandedMemoryId(
                            expandedMemoryId === item.id ? null : item.id,
                          )
                        }
                        onReanchor={() => handleReanchor(item.id)}
                        onTogglePin={() => handleTogglePin(item)}
                        onDelete={() => handleDeleteMemory(item.id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* TAB 4: IDE BRIDGES & PREVIEW */}
            {activeTab === 'bridges' && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="lg:col-span-2 p-5 rounded-xl bg-zinc-900/70 border border-zinc-800 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      {(
                        [
                          ['markdown', '.locus/HANDOFF.md'],
                          ['cursor', '.cursor/rules/locus-handoff.mdc'],
                          ['briefing', 'Pasteable Briefing'],
                        ] as const
                      ).map(([mode, label]) => (
                        <button
                          key={mode}
                          onClick={() => setBridgePreviewMode(mode)}
                          className={`px-3 py-1.5 rounded-lg text-xs font-mono transition cursor-pointer ${
                            bridgePreviewMode === mode
                              ? 'bg-indigo-600 text-white'
                              : 'bg-zinc-950 border border-zinc-800 text-zinc-400 hover:text-zinc-200'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>

                    <button
                      onClick={handleCopyBriefing}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-200 cursor-pointer"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      Copy Shown Output
                    </button>
                  </div>

                  <pre className="p-4 rounded-xl bg-zinc-950 border border-zinc-800 text-xs font-mono text-zinc-200 overflow-x-auto whitespace-pre-wrap leading-relaxed max-h-[540px] overflow-y-auto">
                    {bridgePreviewMode === 'cursor'
                      ? overview.compiled.cursorMdc
                      : bridgePreviewMode === 'markdown'
                        ? overview.compiled.markdown
                        : overview.compiled.clipboardBriefing}
                  </pre>
                </div>

                <div className="p-5 rounded-xl bg-zinc-900/70 border border-zinc-800 space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                      <Wrench className="w-4 h-4 text-indigo-400" />
                      Bridge & MCP Files
                    </h3>
                    <button
                      onClick={handleInitBridges}
                      disabled={busy}
                      className="px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs text-white cursor-pointer"
                    >
                      {overview.bridgeHealth.initialized ? 'Repair / Sync' : 'Initialize'}
                    </button>
                  </div>

                  <div className="space-y-2">
                    {overview.bridgeHealth.files.map((f) => (
                      <div
                        key={f.path}
                        className="flex items-center justify-between px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800/80 text-xs"
                      >
                        <span className="font-mono text-zinc-300 truncate">
                          {f.path}
                        </span>
                        {f.exists ? (
                          <span className="text-emerald-400 font-mono text-[11px] shrink-0 ml-2">
                            {f.sizeBytes}B
                          </span>
                        ) : (
                          <span className="text-zinc-600 text-[11px] shrink-0 ml-2">
                            —
                          </span>
                        )}
                      </div>
                    ))}
                  </div>

                  <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800 text-xs text-zinc-400 space-y-1.5">
                    <div className="font-medium text-zinc-200 flex items-center gap-1.5">
                      <Terminal className="w-3.5 h-3.5 text-indigo-400" />
                      Quick Terminal Commands
                    </div>
                    <div className="font-mono text-[11px] text-zinc-300 space-y-1">
                      <div>$ locus init</div>
                      <div>$ locus sync</div>
                      <div>$ locus handoff --briefing</div>
                      <div>$ locus search "query"</div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* TAB 5: CROSS-IDE TIMELINE */}
            {activeTab === 'timeline' && (
              <div className="p-5 rounded-xl bg-zinc-900/70 border border-zinc-800 space-y-3">
                <h2 className="text-sm font-semibold text-white">
                  Cross-IDE Continuity Stream
                </h2>
                {overview.timeline.length === 0 ? (
                  <p className="text-xs text-zinc-500 py-6 text-center">
                    No events logged yet.
                  </p>
                ) : (
                  <div className="space-y-2.5">
                    {overview.timeline.map((ev) => (
                      <div
                        key={ev.id}
                        className={`flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 rounded-lg border ${
                          ev.eventType === 'ide_switch'
                            ? 'bg-indigo-500/10 border-indigo-500/35'
                            : 'bg-zinc-950 border-zinc-800/80'
                        }`}
                      >
                        <div className="flex items-center gap-2.5">
                          <span
                            className={`text-[11px] font-mono px-2 py-0.5 rounded border ${
                              IDE_BADGE_STYLES[ev.sourceIde] ?? IDE_BADGE_STYLES.cli
                            }`}
                          >
                            {ev.sourceIde}
                          </span>
                          <span className="text-[11px] font-mono text-zinc-500">
                            {ev.eventType}
                          </span>
                          <span className="text-xs text-zinc-200">{ev.summary}</span>
                        </div>
                        <span className="text-[11px] font-mono text-zinc-500">
                          {formatRelativeTime(ev.createdAt)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </main>

      {/* Record Memory Modal */}
      {showRecordModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <form
            onSubmit={handleCreateMemory}
            className="w-full max-w-xl rounded-2xl bg-zinc-900 border border-zinc-800 p-6 space-y-4 shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-white">
                Record Project Memory
              </h3>
              <button
                type="button"
                onClick={() => setShowRecordModal(false)}
                className="text-zinc-400 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Memory Tier</label>
                <select
                  value={memKind}
                  onChange={(e) => setMemKind(e.target.value as MemoryKind)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-white"
                >
                  <option value="research">Research Vault Note</option>
                  <option value="dead_end">Dead End (Do Not Retry)</option>
                  <option value="decision">Architectural Decision</option>
                  <option value="convention">Project Convention</option>
                  <option value="note">General Note</option>
                </select>
              </div>

              <div>
                <label className="block text-xs text-zinc-400 mb-1">Recorded From</label>
                <select
                  value={memIde}
                  onChange={(e) => setMemIde(e.target.value as SourceIde)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-white"
                >
                  <option value="cursor">Cursor</option>
                  <option value="claude-code">Claude Code</option>
                  <option value="windsurf">Windsurf</option>
                  <option value="codex">Codex</option>
                  <option value="ui">Mission Control UI</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs text-zinc-400 mb-1">Title</label>
              <input
                required
                type="text"
                value={memTitle}
                onChange={(e) => setMemTitle(e.target.value)}
                placeholder="Concise title (e.g. Avoid foo-rtc on Node 22 — N-API isolate crash)"
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white"
              />
            </div>

            <div>
              <label className="block text-xs text-zinc-400 mb-1">
                Markdown Details / Rationale / Benchmarks
              </label>
              <textarea
                required
                rows={5}
                value={memBody}
                onChange={(e) => setMemBody(e.target.value)}
                placeholder="Explain the why, root cause, benchmark data, or code snippets…"
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono text-zinc-200"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-zinc-400 mb-1">
                  Tags (comma-separated)
                </label>
                <input
                  type="text"
                  value={memTags}
                  onChange={(e) => setMemTags(e.target.value)}
                  placeholder="webrtc, node22, benchmarks"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-200"
                />
              </div>

              <div>
                <label className="block text-xs text-zinc-400 mb-1">
                  Anchored Files (for Git Drift check)
                </label>
                <input
                  type="text"
                  value={memFiles}
                  onChange={(e) => setMemFiles(e.target.value)}
                  placeholder="src/transport.ts, src/auth.ts"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs font-mono text-zinc-200"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs text-zinc-400 mb-1">
                Reference URLs (optional, comma-separated)
              </label>
              <input
                type="text"
                value={memUrls}
                onChange={(e) => setMemUrls(e.target.value)}
                placeholder="https://..."
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs font-mono text-zinc-200"
              />
            </div>

            <div className="flex items-center justify-between pt-2">
              <label className="inline-flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={memPinned}
                  onChange={(e) => setMemPinned(e.target.checked)}
                  className="rounded border-zinc-700"
                />
                Pin to top of capsule priority
              </label>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowRecordModal(false)}
                  className="px-3.5 py-2 rounded-lg bg-zinc-800 text-xs text-zinc-300 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-medium text-white cursor-pointer"
                >
                  Save to Locus
                </button>
              </div>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function MemoryCard({
  item,
  expanded,
  onToggleExpand,
  onReanchor,
  onTogglePin,
  onDelete,
}: {
  item: MemoryItem;
  expanded: boolean;
  onToggleExpand: () => void;
  onReanchor: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
}) {
  const meta = KIND_META[item.kind] ?? KIND_META.note;

  return (
    <div
      className={`p-4 rounded-xl bg-zinc-900/75 border transition ${meta.border}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div
          onClick={onToggleExpand}
          className="flex-1 cursor-pointer space-y-1.5"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`text-[10px] font-mono uppercase px-2 py-0.5 rounded border ${meta.badge}`}
            >
              {meta.label}
            </span>
            <span
              className={`text-[10px] font-mono px-2 py-0.5 rounded border ${
                IDE_BADGE_STYLES[item.sourceIde] ?? IDE_BADGE_STYLES.cli
              }`}
            >
              {item.sourceIde}
            </span>
            <span className="text-[11px] font-mono text-zinc-500">{item.id}</span>
            {typeof item.score === 'number' && (
              <span className="text-[10px] font-mono text-emerald-400">
                score {item.score.toFixed(2)}
              </span>
            )}
            {item.drift.drifted && (
              <span className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/35">
                <AlertTriangle className="w-3 h-3" />
                Git Drift
              </span>
            )}
          </div>

          <h3 className="text-sm font-medium text-white">{item.title}</h3>
          <p className="text-xs text-zinc-400 leading-relaxed">
            {expanded ? item.summary : item.snippet || item.summary}
          </p>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={onTogglePin}
            title={item.pinned ? 'Unpin' : 'Pin'}
            className={`p-1.5 rounded hover:bg-zinc-800 cursor-pointer ${
              item.pinned ? 'text-amber-400' : 'text-zinc-500'
            }`}
          >
            <Pin className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onDelete}
            title="Delete memory"
            className="p-1.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-rose-400 cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {item.drift.drifted && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/25 text-xs text-amber-200">
          <span>{item.drift.reason}</span>
          <button
            onClick={onReanchor}
            className="px-2.5 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-100 font-medium text-[11px] cursor-pointer"
          >
            Mark Verified at Current HEAD
          </button>
        </div>
      )}

      {expanded && (
        <div className="mt-3 pt-3 border-t border-zinc-800 space-y-2.5">
          <pre className="p-3 rounded-lg bg-zinc-950 border border-zinc-800 text-xs font-mono text-zinc-200 whitespace-pre-wrap leading-relaxed">
            {item.body}
          </pre>

          {item.sourceUrls.length > 0 && (
            <div className="text-xs text-zinc-400 space-x-2">
              <span className="text-zinc-500">Sources:</span>
              {item.sourceUrls.map((u) => (
                <a
                  key={u}
                  href={u}
                  target="_blank"
                  rel="noreferrer"
                  className="text-indigo-400 hover:underline break-all"
                >
                  {u}
                </a>
              ))}
            </div>
          )}
        </div>
      )}

      {(item.tags.length > 0 || item.relatedFiles.length > 0) && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {item.tags.map((tag) => (
            <span
              key={tag}
              className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-950 border border-zinc-800 text-zinc-400"
            >
              #{tag}
            </span>
          ))}
          {item.relatedFiles.map((file) => (
            <span
              key={file}
              className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-950 border border-zinc-800 text-zinc-300"
            >
              <FileCode2 className="w-3 h-3 text-zinc-500" />
              {file}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
