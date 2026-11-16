/**
 * Deterministic token estimation and Markdown line/item budgeting.
 * Calibrated for mixed Markdown + code paths + identifiers used in IDE rules.
 */

export function estimateTokens(text: string): number {
  if (!text) return 0;

  // Split into words, numbers, punctuation clusters, and newlines
  const segments = text.match(/[A-Za-z]+|[0-9]+|\n|[^\sA-Za-z0-9]/g);
  if (!segments) return Math.ceil(text.length / 4);

  let count = 0;
  for (const seg of segments) {
    if (seg === '\n') {
      count += 0.5;
    } else if (/^[A-Za-z]+$/.test(seg)) {
      // Long identifiers or compound words split into ~5-char BPE subwords
      count += seg.length <= 6 ? 1 : Math.ceil(seg.length / 5);
    } else if (/^[0-9]+$/.test(seg)) {
      count += Math.ceil(seg.length / 3);
    } else {
      count += 0.65;
    }
  }

  return Math.max(1, Math.ceil(count));
}

export function truncateToTokens(text: string, maxTokens: number): string {
  if (!text || maxTokens <= 0) return '';
  if (estimateTokens(text) <= maxTokens) return text;

  const lines = text.split('\n');
  const kept: string[] = [];
  let used = 0;

  for (const line of lines) {
    const lineTokens = estimateTokens(line) + 1;
    if (used + lineTokens > maxTokens) {
      if (kept.length === 0) {
        // Slice single long line proportionally
        const approxChars = Math.max(24, Math.floor(maxTokens * 3.6));
        return line.slice(0, approxChars).trimEnd() + '…';
      }
      kept.push('…');
      break;
    }
    kept.push(line);
    used += lineTokens;
  }

  return kept.join('\n');
}

export function deriveSummary(body: string, maxChars = 180): string {
  const cleaned = body
    .replace(/```[\s\S]*?```/g, '[code snippet]')
    .replace(/^#+\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length <= maxChars) return cleaned;

  const sentenceBreak = cleaned.slice(0, maxChars).lastIndexOf('. ');
  if (sentenceBreak > maxChars * 0.45) {
    return cleaned.slice(0, sentenceBreak + 1);
  }
  return cleaned.slice(0, maxChars - 1).trimEnd() + '…';
}
