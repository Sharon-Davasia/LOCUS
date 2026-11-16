import type { LocusEngine } from '../core/engine.js';
import { estimateTokens, truncateToTokens } from '../core/tokens.js';
import type {
  CompiledContext,
  MemoryWithDrift,
  TaskStep,
  TokenBudgetReport,
} from '../types.js';

export interface CompileOptions {
  projectPath?: string;
  branch?: string;
  maxTokens?: number;
}

function taskCheckbox(step: TaskStep): string {
  switch (step.status) {
    case 'done':
      return '[x]';
    case 'in_progress':
      return '[/]';
    case 'blocked':
      return '[!]';
    default:
      return '[ ]';
  }
}

function driftBadge(mem: MemoryWithDrift): string {
  if (!mem.drift.drifted) return '';
  if (mem.drift.missingFiles.length > 0) {
    return ` _(verify: ${mem.drift.missingFiles.join(', ')} removed)_`;
  }
  return ` _(verify: ${mem.drift.changedFiles.join(', ')} changed)_`;
}

export function compileProjectContext(
  engine: LocusEngine,
  options: CompileOptions = {},
): CompiledContext {
  const maxTokens = Math.max(300, options.maxTokens ?? 850);
  const { project, git } = engine.ensureProject(options.projectPath ?? process.cwd());
  const branch = options.branch ?? git.branch;
  const handoff = engine.getHandoff(project.id, branch, git.repoRoot);

  const allActive = engine.listMemories({
    projectId: project.id,
    status: 'active',
    branch,
    limit: 120,
    projectPath: git.repoRoot,
  });

  const deadEnds = allActive.filter((m) => m.kind === 'dead_end');
  const decisions = allActive.filter((m) => m.kind === 'decision');
  const conventions = allActive.filter((m) => m.kind === 'convention');
  const research = allActive.filter((m) => m.kind === 'research' || m.kind === 'note');

  const compiledAt = new Date().toISOString();

  // 1. Build MCP Continuity Footer first (small fixed guidance)
  const mcpGuideLines = [
    '## Locus Continuity Protocol',
    '- Call `locus_search` / `locus_get_entry` to pull full research notes or past context on demand.',
    '- Call `locus_record` immediately when making an architectural `decision`, hitting a `dead_end`, or synthesizing `research`.',
    '- Call `locus_checkpoint` when completing milestones or before ending/switching IDE sessions.',
  ];
  const mcpGuideText = mcpGuideLines.join('\n');
  const mcpGuideTokens = estimateTokens(mcpGuideText);

  // 2. Build Git Working Tree section
  const gitLines: string[] = [
    '## Live Git State',
    `- **Project:** \`${project.name}\` | **Branch:** \`${branch}\`${git.shortSha ? ` (\`${git.shortSha}\`)` : ''} | **Last Active IDE:** \`${handoff.lastIde}\``,
  ];
  if (git.dirtyFiles.length > 0) {
    const previewDirty = git.dirtyFiles
      .slice(0, 8)
      .map((f) => `\`${f.path}\` (${f.status})`)
      .join(', ');
    const more =
      git.dirtyFiles.length > 8 ? ` +${git.dirtyFiles.length - 8} more` : '';
    gitLines.push(`- **Uncommitted Changes (${git.dirtyFiles.length}):** ${previewDirty}${more}`);
  } else {
    gitLines.push('- **Working Tree:** Clean');
  }
  const gitStateText = truncateToTokens(gitLines.join('\n'), Math.floor(maxTokens * 0.16));
  const gitStateTokens = estimateTokens(gitStateText);

  // 3. Build Active Handoff Capsule section
  const handoffLines: string[] = ['## Active Handoff Capsule'];
  if (handoff.objective) {
    handoffLines.push(`- **Objective:** ${handoff.objective}`);
  } else if (git.recentCommits.length > 0) {
    handoffLines.push(
      `- **Objective:** No explicit checkpoint set yet (latest commit: "${git.recentCommits[0].subject}").`,
    );
  } else {
    handoffLines.push('- **Objective:** Ready for initial checkpoint.');
  }

  if (handoff.summary) {
    handoffLines.push(`- **State Summary:** ${handoff.summary}`);
  }
  if (handoff.activeHypothesis) {
    handoffLines.push(`- **Active Hypothesis:** ${handoff.activeHypothesis}`);
  }
  if (handoff.blockers.length > 0) {
    handoffLines.push(
      `- **Blockers:** ${handoff.blockers.map((b) => `${b}`).join(' | ')}`,
    );
  }
  if (handoff.tasks.length > 0) {
    handoffLines.push('### Tasks');
    for (const step of handoff.tasks.slice(0, 8)) {
      const filesHint =
        step.files && step.files.length > 0
          ? ` (\`${step.files.slice(0, 2).join('`, `')}\`)`
          : '';
      handoffLines.push(`- ${taskCheckbox(step)} ${step.text}${filesHint}`);
    }
  }
  if (handoff.nextSteps.length > 0) {
    handoffLines.push('### Immediate Next Steps');
    for (const step of handoff.nextSteps.slice(0, 5)) {
      handoffLines.push(`1. ${step}`);
    }
  }

  const handoffBudget = Math.floor(maxTokens * 0.36);
  const handoffText = truncateToTokens(handoffLines.join('\n'), handoffBudget);
  const handoffTokens = estimateTokens(handoffText);

  let remainingTokens = Math.max(
    80,
    maxTokens - mcpGuideTokens - gitStateTokens - handoffTokens - 25,
  );

  let omittedCount = 0;

  // Helper to pack memory items within a token slice
  const packMemories = (
    heading: string,
    items: MemoryWithDrift[],
    sectionBudget: number,
    formatter: (m: MemoryWithDrift) => string,
  ): { text: string; tokens: number } => {
    if (items.length === 0 || sectionBudget < 20) {
      omittedCount += items.length;
      return { text: '', tokens: 0 };
    }
    const lines = [heading];
    let used = estimateTokens(heading) + 1;
    let included = 0;

    for (const item of items) {
      const formatted = formatter(item);
      const t = estimateTokens(formatted) + 1;
      if (used + t > sectionBudget && included > 0) {
        break;
      }
      if (used + t > sectionBudget && included === 0) {
        lines.push(truncateToTokens(formatted, Math.max(18, sectionBudget - used)));
        included++;
        break;
      }
      lines.push(formatted);
      used += t;
      included++;
    }

    const leftOut = items.length - included;
    if (leftOut > 0) {
      omittedCount += leftOut;
      lines.push(`- _(+${leftOut} more in Locus — query via \`locus_search\`)_`);
    }

    const text = lines.join('\n');
    return { text, tokens: estimateTokens(text) };
  };

  // 4. Dead Ends (high value — saves agents from repeating mistakes)
  const deadEndShare = deadEnds.length > 0 ? Math.floor(remainingTokens * 0.36) : 0;
  const deadEndPacked = packMemories(
    '## Dead Ends — Do Not Retry',
    deadEnds,
    deadEndShare,
    (m) => `- **${m.title}:** ${m.summary}${driftBadge(m)}`,
  );
  remainingTokens = Math.max(0, remainingTokens - deadEndPacked.tokens);

  // 5. Architectural Decisions
  const decisionShare = decisions.length > 0 ? Math.floor(remainingTokens * 0.45) : 0;
  const decisionPacked = packMemories(
    '## Key Decisions',
    decisions,
    decisionShare,
    (m) => `- **${m.title}:** ${m.summary}${driftBadge(m)}`,
  );
  remainingTokens = Math.max(0, remainingTokens - decisionPacked.tokens);

  // 6. Conventions
  const conventionShare =
    conventions.length > 0 ? Math.floor(remainingTokens * 0.45) : 0;
  const conventionPacked = packMemories(
    '## Conventions & Invariants',
    conventions,
    conventionShare,
    (m) => `- **${m.title}:** ${m.summary}`,
  );
  remainingTokens = Math.max(0, remainingTokens - conventionPacked.tokens);

  // 7. Research Vault Index (Progressive Disclosure: title + id + tags only!)
  const researchPacked = packMemories(
    '## Research Vault Index (Pull via `locus_get_entry`)',
    research,
    remainingTokens,
    (m) => {
      const tagStr = m.tags.length > 0 ? ` [${m.tags.slice(0, 3).join(', ')}]` : '';
      return `- \`${m.id}\` — **${m.title}**${tagStr}${driftBadge(m)}`;
    },
  );

  const header = `# Locus Context Capsule — ${project.name} (${branch})`;
  const sections = [
    header,
    handoffText,
    gitStateText,
    deadEndPacked.text,
    decisionPacked.text,
    conventionPacked.text,
    researchPacked.text,
    mcpGuideText,
  ].filter(Boolean);

  const markdown = sections.join('\n\n') + '\n';
  const usedTokens = estimateTokens(markdown);

  const cursorMdc = [
    '---',
    `description: Locus live project memory and cross-IDE handoff state for ${project.name}`,
    'globs: ',
    'alwaysApply: true',
    '---',
    '',
    markdown.trimEnd(),
    '',
  ].join('\n');

  const clipboardBriefing = [
    'You are resuming active work on this repository. Read the Locus handoff state below before taking action:',
    '',
    markdown.trimEnd(),
  ].join('\n');

  const tokenReport: TokenBudgetReport = {
    totalBudget: maxTokens,
    usedTokens,
    utilizationPct: Math.min(100, Math.round((usedTokens / maxTokens) * 100)),
    sections: {
      handoff: handoffTokens,
      gitState: gitStateTokens,
      deadEnds: deadEndPacked.tokens,
      decisions: decisionPacked.tokens,
      conventions: conventionPacked.tokens,
      researchIndex: researchPacked.tokens,
      mcpGuide: mcpGuideTokens,
    },
    omittedCount,
  };

  return {
    markdown,
    cursorMdc,
    clipboardBriefing,
    tokenReport,
    compiledAt,
  };
}
