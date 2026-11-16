import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DriftStatus, GitCommitSummary, GitFileChange, GitRepoState } from '../types.js';

const GENERATED_BRIDGE_PATHS = new Set([
  '.locus',
  'CLAUDE.local.md',
  '.cursor/rules/locus-handoff.mdc',
  '.windsurf/rules/locus-handoff.md',
]);

function runGit(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trimEnd();
  } catch {
    return null;
  }
}

function isBridgeNoisePath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/');
  if (normalized === '.locus' || normalized.startsWith('.locus/')) return true;
  return GENERATED_BRIDGE_PATHS.has(normalized);
}

export function inspectGitRepo(targetPath: string): GitRepoState {
  const resolvedTarget = path.resolve(targetPath);

  const topLevel = runGit(resolvedTarget, ['rev-parse', '--show-toplevel']);
  if (!topLevel) {
    return {
      isGitRepo: false,
      repoRoot: resolvedTarget,
      gitDir: null,
      gitCommonDir: null,
      branch: 'default',
      headSha: null,
      shortSha: null,
      dirtyFiles: [],
      diffStat: '',
      recentCommits: [],
      dirtySignature: 'non-git',
    };
  }

  const repoRoot = fs.realpathSync.native(topLevel.trim());
  const rawGitDir = runGit(repoRoot, ['rev-parse', '--git-dir']);
  const rawCommonDir = runGit(repoRoot, ['rev-parse', '--git-common-dir']);

  const gitDir = rawGitDir
    ? fs.realpathSync.native(path.resolve(repoRoot, rawGitDir.trim()))
    : null;
  const gitCommonDir = rawCommonDir
    ? fs.realpathSync.native(path.resolve(repoRoot, rawCommonDir.trim()))
    : gitDir;

  // Detect branch (works even on unborn HEAD before first commit)
  let branch =
    runGit(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'])?.trim() || '';
  const headSha = runGit(repoRoot, ['rev-parse', '--verify', 'HEAD'])?.trim() || null;
  const shortSha = headSha ? headSha.slice(0, 8) : null;

  if (!branch) {
    branch = shortSha ? `detached-${shortSha}` : 'main';
  }

  // Parse porcelain status
  const porcelain = runGit(repoRoot, ['status', '--porcelain=v1', '-uall']) ?? '';
  const dirtyFiles: GitFileChange[] = [];

  if (porcelain) {
    for (const rawLine of porcelain.split('\n')) {
      if (rawLine.length < 4) continue;
      const indexCode = rawLine[0];
      const workTreeCode = rawLine[1];
      let filePath = rawLine.slice(3).trim();
      if (filePath.includes(' -> ')) {
        filePath = filePath.split(' -> ').pop()!.trim();
      }
      if (filePath.startsWith('"') && filePath.endsWith('"')) {
        filePath = filePath.slice(1, -1);
      }
      if (isBridgeNoisePath(filePath)) continue;

      let status: GitFileChange['status'] = 'modified';
      if (indexCode === '?' && workTreeCode === '?') {
        status = 'untracked';
      } else if (indexCode === 'A' || workTreeCode === 'A') {
        status = 'added';
      } else if (indexCode === 'D' || workTreeCode === 'D') {
        status = 'deleted';
      } else if (indexCode === 'R' || workTreeCode === 'R') {
        status = 'renamed';
      }

      dirtyFiles.push({
        path: filePath,
        status,
        staged: indexCode !== ' ' && indexCode !== '?',
      });
    }
  }

  const diffStat =
    (headSha
      ? runGit(repoRoot, ['diff', '--stat', 'HEAD', '--', '.', ':!.locus'])
      : runGit(repoRoot, ['diff', '--stat'])) ?? '';

  const recentCommits: GitCommitSummary[] = [];
  if (headSha) {
    const logOut = runGit(repoRoot, [
      'log',
      '-n',
      '5',
      '--format=%H%x1f%h%x1f%s%x1f%an%x1f%cI',
    ]);
    if (logOut) {
      for (const line of logOut.split('\n')) {
        const [sha, sSha, subject, author, timestamp] = line.split('\x1f');
        if (sha && subject) {
          recentCommits.push({
            sha,
            shortSha: sSha || sha.slice(0, 8),
            subject,
            author: author || 'unknown',
            timestamp: timestamp || '',
          });
        }
      }
    }
  }

  const sigPayload = JSON.stringify({
    headSha,
    dirty: dirtyFiles.map((f) => `${f.status}:${f.staged ? 'S' : 'W'}:${f.path}`),
  });
  const dirtySignature = createHash('sha1').update(sigPayload).digest('hex').slice(0, 12);

  return {
    isGitRepo: true,
    repoRoot,
    gitDir,
    gitCommonDir,
    branch,
    headSha,
    shortSha,
    dirtyFiles,
    diffStat: diffStat.trim(),
    recentCommits,
    dirtySignature,
  };
}

export class GitDriftInspector {
  private readonly commitDiffCache = new Map<string, Set<string> | null>();
  private readonly dirtySet: Set<string>;

  constructor(private readonly gitState: GitRepoState) {
    this.dirtySet = new Set(gitState.dirtyFiles.map((d) => d.path.replace(/\\/g, '/')));
  }

  checkDrift(anchorCommit: string | null, relatedFiles: string[]): DriftStatus {
    if (!relatedFiles || relatedFiles.length === 0) {
      return { drifted: false, changedFiles: [], missingFiles: [] };
    }

    const normalizedFiles = relatedFiles.map((f) => f.replace(/\\/g, '/').replace(/^\.\//, ''));
    const missingFiles: string[] = [];
    const changedSet = new Set<string>();

    for (const rel of normalizedFiles) {
      const abs = path.resolve(this.gitState.repoRoot, rel);
      if (!fs.existsSync(abs)) {
        missingFiles.push(rel);
      }
      if (this.dirtySet.has(rel)) {
        changedSet.add(rel);
      }
    }

    if (
      this.gitState.isGitRepo &&
      anchorCommit &&
      this.gitState.headSha &&
      anchorCommit !== this.gitState.headSha
    ) {
      const diffSinceAnchor = this.getChangedFilesSince(anchorCommit);
      if (diffSinceAnchor) {
        for (const rel of normalizedFiles) {
          if (diffSinceAnchor.has(rel)) {
            changedSet.add(rel);
          }
        }
      }
    }

    const changedFiles = Array.from(changedSet);
    const drifted = missingFiles.length > 0 || changedFiles.length > 0;

    let reason: string | undefined;
    if (missingFiles.length > 0) {
      reason = `Referenced file(s) removed or renamed: ${missingFiles.join(', ')}`;
    } else if (changedFiles.length > 0) {
      reason = `Referenced file(s) modified since memory was recorded: ${changedFiles.join(', ')}`;
    }

    return {
      drifted,
      changedFiles,
      missingFiles,
      reason,
    };
  }

  private getChangedFilesSince(anchorCommit: string): Set<string> | null {
    if (this.commitDiffCache.has(anchorCommit)) {
      return this.commitDiffCache.get(anchorCommit)!;
    }

    if (!this.gitState.headSha) {
      this.commitDiffCache.set(anchorCommit, null);
      return null;
    }

    const out = runGit(this.gitState.repoRoot, [
      'diff',
      '--name-only',
      `${anchorCommit}..${this.gitState.headSha}`,
    ]);

    if (out === null) {
      this.commitDiffCache.set(anchorCommit, null);
      return null;
    }

    const files = new Set(
      out
        .split('\n')
        .map((s) => s.trim().replace(/\\/g, '/'))
        .filter(Boolean),
    );
    this.commitDiffCache.set(anchorCommit, files);
    return files;
  }
}
