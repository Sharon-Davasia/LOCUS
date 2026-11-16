const VECTOR_DIM = 256;

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'are',
  'was', 'were', 'been', 'into', 'about', 'what', 'when', 'where',
  'which', 'will', 'would', 'could', 'should', 'there', 'their', 'they',
  'them', 'then', 'than', 'also', 'just', 'only', 'very', 'some', 'more',
]);

/**
 * Splits camelCase, PascalCase, snake_case, kebab-case, and paths into normalized tokens.
 */
export function tokenizeText(text: string): string[] {
  if (!text) return [];

  // Split camelCase / PascalCase boundaries first
  const expanded = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase();

  const rawTokens = expanded.match(/[a-z0-9]{2,}/g) ?? [];
  const tokens: string[] = [];

  for (const tok of rawTokens) {
    if (STOP_WORDS.has(tok)) continue;
    tokens.push(tok);
    // Light suffix stemming for English technical prose
    const stem = lightStem(tok);
    if (stem !== tok && stem.length >= 3) {
      tokens.push(stem);
    }
  }

  return tokens;
}

function lightStem(word: string): string {
  if (word.length <= 4) return word;
  if (word.endsWith('ies') && word.length > 5) return word.slice(0, -3) + 'y';
  if (word.endsWith('ing') && word.length > 5) return word.slice(0, -3);
  if (word.endsWith('tion') && word.length > 6) return word.slice(0, -4);
  if (word.endsWith('ments') && word.length > 7) return word.slice(0, -5);
  if (word.endsWith('ment') && word.length > 6) return word.slice(0, -4);
  if (word.endsWith('ed') && word.length > 4) return word.slice(0, -2);
  if (word.endsWith('es') && word.length > 4) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 4) {
    return word.slice(0, -1);
  }
  return word;
}

function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Computes a deterministic L2-normalized 256-dim feature-hashed vector
 * combining identifier subwords, stems, token bigrams, and 4-char n-grams.
 */
export function computeLocalEmbedding(
  title: string,
  summary: string,
  body: string,
  tags: string[] = [],
  relatedFiles: string[] = [],
): Float32Array {
  const vec = new Float32Array(VECTOR_DIM);

  const addFeatures = (input: string, weight: number) => {
    const tokens = tokenizeText(input);
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      accumulateFeature(vec, `w:${tok}`, weight);

      if (i + 1 < tokens.length) {
        accumulateFeature(vec, `bi:${tok}_${tokens[i + 1]}`, weight * 0.65);
      }

      if (tok.length >= 5) {
        for (let j = 0; j <= tok.length - 4; j++) {
          accumulateFeature(vec, `ng:${tok.slice(j, j + 4)}`, weight * 0.25);
        }
      }
    }
  };

  addFeatures(title, 3.0);
  addFeatures(tags.join(' '), 2.5);
  addFeatures(relatedFiles.join(' '), 2.0);
  addFeatures(summary, 1.8);
  addFeatures(body, 1.0);

  let normSq = 0;
  for (let i = 0; i < VECTOR_DIM; i++) {
    normSq += vec[i] * vec[i];
  }

  if (normSq > 0) {
    const invNorm = 1 / Math.sqrt(normSq);
    for (let i = 0; i < VECTOR_DIM; i++) {
      vec[i] *= invNorm;
    }
  }

  return vec;
}

function accumulateFeature(vec: Float32Array, feature: string, weight: number): void {
  const h = fnv1a(feature);
  const idx = h & (VECTOR_DIM - 1);
  const sign = (h & 0x100) === 0 ? 1 : -1;
  vec[idx] += sign * weight;
}

export function embeddingToBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function blobToEmbedding(blob: Buffer | Uint8Array | null): Float32Array | null {
  if (!blob || blob.byteLength !== VECTOR_DIM * 4) return null;
  const aligned = new Uint8Array(blob.byteLength);
  aligned.set(blob);
  return new Float32Array(aligned.buffer);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array | null): number {
  if (!b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return Math.max(0, Math.min(1, dot));
}

/**
 * Safely converts arbitrary user/agent queries (including paths like `src/foo-bar.ts`
 * or error messages) into a valid SQLite FTS5 MATCH expression.
 */
export function buildFtsQuery(rawQuery: string): string | null {
  const cleaned = rawQuery
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();

  const rawTokens = cleaned.match(/[a-z0-9]{2,}/g) ?? [];
  const unique = Array.from(
    new Set(rawTokens.filter((t) => !STOP_WORDS.has(t))),
  ).slice(0, 12);

  if (unique.length === 0) return null;

  // Use prefix matching on tokens >= 3 chars joined with OR so partial overlap scores via BM25
  return unique
    .map((tok) => (tok.length >= 3 ? `"${tok}"*` : `"${tok}"`))
    .join(' OR ');
}

export function computeRecencyScore(isoTimestamp: string): number {
  const ts = Date.parse(isoTimestamp);
  if (Number.isNaN(ts)) return 0.5;
  const ageHours = Math.max(0, (Date.now() - ts) / (1000 * 60 * 60));
  // Half-life ~14 days (336 hours)
  return 1 / (1 + ageHours / 336);
}

export function buildSearchSnippet(
  body: string,
  summary: string,
  query: string,
  maxLength = 220,
): string {
  const tokens = tokenizeText(query);
  const text = (body || summary).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= maxLength) return text;

  const lower = text.toLowerCase();
  let bestPos = -1;
  for (const tok of tokens) {
    const idx = lower.indexOf(tok);
    if (idx !== -1 && (bestPos === -1 || idx < bestPos)) {
      bestPos = idx;
    }
  }

  if (bestPos <= 40) {
    return text.slice(0, maxLength - 1).trimEnd() + '…';
  }

  const start = Math.max(0, bestPos - 50);
  const slice = text.slice(start, start + maxLength - 2).trim();
  return (start > 0 ? '…' : '') + slice + (start + maxLength - 2 < text.length ? '…' : '');
}
