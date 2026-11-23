// main.ts is mend, the CLI SPEC.md specifies (MIT). It does sections 1 to 10 of SPEC.md: the command line, the
// output and exit codes, safe paths, format detection, JSON edits and the all-or-nothing write, and the three
// line-based formats (unified diff, SEARCH/REPLACE, V4A) with matching at three tiers (section 5).
//
// Architecture: one generic parser per format, all feeding one central matcher. A file is read as a Doc: its own
// line break (CRLF when its first line feed follows a carriage return, LF otherwise), its lines split at that
// break, and whether it ends with a break. Matching never sees a stray '\r', and a changed file is written back
// with its own break and its own final break (only a unified hunk may change the final break, section 6), so a
// V4A edit of a CRLF file matches, applies, and stays CRLF. The matcher finds, at the first tier where the old
// lines occur at all (0 exact, 1 trailing spaces/tabs ignored, 2 leading and trailing ignored; --strict tries
// tier 0 only), every occurrence; each format then takes the occurrence its section names (unified: nearest to
// A - 1 + drift, earlier on a tie; SEARCH/REPLACE: exactly one or ambiguous; V4A: first at or after the cursor).
// A context line is always written as the file's own matched line, never the patch's; at tier 2 every other line
// of N is re-indented from O's first line's leading spaces/tabs P to the file's first matched line's F.
//
// V4A anchor rule (SPEC section 8, exclusive cursor): a chunk's anchor is found first, the cursor moves past
// it, and O is searched at or after the cursor; an insertion-only chunk inserts at the cursor. An anchor that
// is also O's first line therefore does not match O at the anchor line itself. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// ---------- files: one document, its own line break (SPEC section 3) ----------

interface Doc {
  br: string;
  lines: string[];
  final: boolean;
}

/** A file's line break is CRLF when its first line feed follows a carriage return, LF otherwise; its lines are
    its text split at that break; the empty piece after a final break is not a line; an empty file has no lines. */
function parseDoc(text: string): Doc {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

/** A file of no lines is written empty; otherwise its lines joined by its break, with a final one exactly when it
    ended with one. */
function writeDoc(d: Doc): string {
  return d.lines.length === 0 ? '' : d.lines.join(d.br) + (d.final ? d.br : '');
}

const leadWS = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const onlyWS = (s: string): boolean => /^[ \t]*$/.test(s);

// ---------- the central matcher (SPEC section 5) ----------

function matchKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions at or after `from` where O matches the file's lines at this tier; occurrences may overlap. */
function occurrences(O: string[], lines: string[], tier: number, from: number): number[] {
  const pos: number[] = [];
  if (O.length === 0 || O.length > lines.length - from) return pos;
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (matchKey(lines[i + j]!, tier) !== matchKey(O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) pos.push(i);
  }
  return pos;
}

/** The first tier at which O occurs at or after `from`, with every position there; null when it occurs at no tier.
    With --strict only tier 0 is tried. */
function findMatch(
  O: string[],
  lines: string[],
  strict: boolean,
  from: number,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const p = occurrences(O, lines, t, from);
    if (p.length > 0) return { tier: t, positions: p };
  }
  return null;
}

/** One line of N: its text, and its index into O when it is a context line (else null). */
interface NLine {
  text: string;
  ctx: number | null;
}

/** Replace O's lines at `at` by N. A context line is written as the file's own matched line, never the patch's.
    At tier 2 every other line of N is re-indented: let F be the leading spaces and tabs of the file's first
    matched line and P those of O's first line; a line of N that is not empty and not only whitespace, and starts
    with P, has that P replaced by F; any other line is written as it is. At tiers 0 and 1 the lines of N are
    written as they are. With an empty O this is an insertion, and no re-indentation applies. */
function applyReplace(lines: string[], O: string[], N: NLine[], at: number, tier: number): string[] {
  const out = lines.slice(0, at);
  const F = tier === 2 && O.length > 0 ? leadWS(lines[at]!) : '';
  const P = tier === 2 && O.length > 0 ? leadWS(O[0]!) : '';
  for (const n of N) {
    if (n.ctx !== null) out.push(lines[at + n.ctx]!);
    else if (tier === 2 && !onlyWS(n.text) && n.text.startsWith(P)) out.push(F + n.text.slice(P.length));
    else out.push(n.text);
  }
  out.push(...lines.slice(at + O.length));
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  recordMove(oldP: string, newP: string): void {
    this.moves.push([oldP, newP]);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- unified diffs (SPEC section 6) ----------

/** One body line of a unified hunk. `empty` marks a context line that came from an empty patch line. */
interface UBody {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
  empty: boolean;
}
interface UHunk {
  A: number;
  body: UBody[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Split a hunk body into O (context and `-` lines, in body order) and N (context and `+` lines, in body order). */
function hunkON(h: UHunk): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const b of h.body) {
    if (b.kind === 'ctx') {
      N.push({ text: b.text, ctx: O.length });
      O.push(b.text);
    } else if (b.kind === 'old') O.push(b.text);
    else if (b.kind === 'new') N.push({ text: b.text, ctx: null });
  }
  return { O, N };
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function hunkNoBreak(h: UHunk): boolean {
  for (let i = h.body.length - 1; i >= 0; i--) {
    const b = h.body[i]!;
    if (b.kind === 'ctx' || b.kind === 'new') {
      return i + 1 < h.body.length && h.body[i + 1]!.kind === 'bs';
    }
  }
  return false;
}

function stripAB(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  interface Sec {
    pairOld: string | null;
    pairNew: string | null;
    renOld: string | null;
    renNew: string | null;
    gitOld: string | null;
    gitNew: string | null;
    newFile: boolean;
    deletedFile: boolean;
    hunks: UHunk[];
    hasPair: boolean;
  }
  const secs: Sec[] = [];
  let cur: Sec | null = null;
  let inHeader = false;
  let i = 0;
  const startSection = (s: Sec): void => {
    secs.push(s);
    cur = s;
    inHeader = true;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const rest = line.slice('diff --git '.length);
      const sep = rest.indexOf(' b/');
      if (!rest.startsWith('a/') || sep < 0) throw new Exit2(`error: parse ${i + 1}`);
      startSection({
        pairOld: null,
        pairNew: null,
        renOld: null,
        renNew: null,
        gitOld: rest.slice(2, sep),
        gitNew: rest.slice(sep + 3),
        newFile: false,
        deletedFile: false,
        hunks: [],
        hasPair: false,
      });
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = stripAB(line.slice(4).split('\t')[0]!.trim());
      const newP = stripAB(lines[i + 1]!.slice(4).split('\t')[0]!.trim());
      if (cur !== null && inHeader && !cur.hasPair) {
        cur.pairOld = oldP;
        cur.pairNew = newP;
        cur.hasPair = true;
      } else {
        startSection({
          pairOld: oldP,
          pairNew: newP,
          renOld: null,
          renNew: null,
          gitOld: null,
          gitNew: null,
          newFile: false,
          deletedFile: false,
          hunks: [],
          hasPair: true,
        });
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const A = Number(m[1]);
      inHeader = false;
      const body: UBody[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') {
          body.push({ kind: 'ctx', text: '', empty: true });
          j++;
          continue;
        }
        if (bl.startsWith(' ')) {
          body.push({ kind: 'ctx', text: bl.slice(1), empty: false });
          j++;
          continue;
        }
        if (bl.startsWith('-')) {
          body.push({ kind: 'old', text: bl.slice(1), empty: false });
          j++;
          continue;
        }
        if (bl.startsWith('+')) {
          body.push({ kind: 'new', text: bl.slice(1), empty: false });
          j++;
          continue;
        }
        if (bl.startsWith('\\')) {
          body.push({ kind: 'bs', text: bl, empty: false });
          j++;
          continue;
        }
        break;
      }
      // Empty lines at the end of a body are not part of it.
      while (body.length > 0 && body[body.length - 1]!.kind === 'ctx' && body[body.length - 1]!.empty) body.pop();
      cur.hunks.push({ A, body });
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur.renOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      // every other header line is ignored
    }
    // Outside bodies, lines that are not part of a section header are ignored.
    i++;
  }
  const edits: Edit[] = [];
  for (const s of secs) {
    const oldStr = s.pairOld ?? s.renOld ?? s.gitOld ?? '';
    const newStr = s.pairNew ?? s.renNew ?? s.gitNew ?? '';
    const isCreate = oldStr === '/dev/null' || s.newFile;
    const isDelete = !isCreate && (newStr === '/dev/null' || s.deletedFile);
    if (isCreate) {
      const p = newStr;
      const plusLines: string[] = [];
      let lastPlus: { h: UHunk; idx: number } | null = null;
      for (const h of s.hunks) {
        h.body.forEach((b, idx) => {
          if (b.kind === 'new') {
            plusLines.push(b.text);
            lastPlus = { h, idx };
          }
        });
      }
      const noBreak =
        lastPlus !== null && lastPlus.idx + 1 < lastPlus.h.body.length && lastPlus.h.body[lastPlus.idx + 1]!.kind === 'bs';
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, writeDoc({ br: '\n', lines: plusLines, final: !noBreak }));
      });
      continue;
    }
    if (isDelete) {
      const p = oldStr;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }
    const isMove = oldStr !== newStr;
    const hunks = s.hunks;
    edits.push((tree) => {
      if (!safe(oldStr)) throw new Fail('unsafe', oldStr);
      if (isMove && !safe(newStr)) throw new Fail('unsafe', newStr);
      const before = tree.get(oldStr);
      if (before === null) throw new Fail('missing', oldStr);
      if (isMove && tree.get(newStr) !== null) throw new Fail('exists', newStr);
      let doc = parseDoc(before);
      let d = 0;
      for (const h of hunks) {
        const { O, N } = hunkON(h);
        if (O.length === 0) {
          const at = Math.max(0, Math.min(h.A + d, doc.lines.length));
          const touchesEnd = at === doc.lines.length;
          doc.lines = applyReplace(doc.lines, [], N, at, 0);
          if (touchesEnd) doc.final = !hunkNoBreak(h);
          d += N.length;
        } else {
          const found = findMatch(O, doc.lines, strict, 0);
          if (found === null) throw new Fail('no-match', oldStr);
          const target = h.A - 1 + d;
          let best = found.positions[0]!;
          let bestDist = Math.abs(best - target);
          for (const p of found.positions) {
            const dist = Math.abs(p - target);
            if (dist < bestDist) {
              best = p;
              bestDist = dist;
            }
          }
          const touchesEnd = best + O.length === doc.lines.length;
          doc.lines = applyReplace(doc.lines, O, N, best, found.tier);
          if (touchesEnd) doc.final = !hunkNoBreak(h);
          d += N.length - O.length;
        }
      }
      const out = writeDoc(doc);
      if (isMove) {
        tree.now.set(oldStr, null);
        tree.now.set(newStr, out);
        tree.recordMove(oldStr, newStr);
      } else {
        tree.now.set(oldStr, out);
      }
    });
  }
  return edits;
}

// ---------- SEARCH/REPLACE blocks (SPEC section 7) ----------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1; // index of the previous block's >>>>>>> REPLACE line
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    // The path is the nearest line before the SEARCH line, and after the previous block's REPLACE line (or the
    // start of the patch), that is not blank and does not start with three backticks.
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    // The ======= line, then the >>>>>>> REPLACE line; a >>>>>>> or the end of the patch first is a parse fault.
    let e = -1;
    for (let j = s + 1; j < lines.length; j++) {
      const l = lines[j]!.trimEnd();
      if (l === '=======') {
        e = j;
        break;
      }
      if (l === '>>>>>>> REPLACE') throw new Exit2(`error: parse ${s + 1}`);
    }
    if (e < 0) throw new Exit2(`error: parse ${s + 1}`);
    let r = -1;
    for (let j = e + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        r = j;
        break;
      }
    }
    if (r < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, e);
    const newLines = lines.slice(e + 1, r);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, writeDoc({ br: '\n', lines: [...newLines], final: true }));
      } else {
        const cur = tree.get(p);
        if (cur === null) throw new Fail('missing', p);
        const doc = parseDoc(cur);
        const found = findMatch(oldLines, doc.lines, strict, 0);
        if (found === null) throw new Fail('no-match', p);
        if (found.positions.length > 1) throw new Fail('ambiguous', p);
        const N: NLine[] = newLines.map((t) => ({ text: t, ctx: null }));
        doc.lines = applyReplace(doc.lines, oldLines, N, found.positions[0]!, found.tier);
        tree.now.set(p, writeDoc(doc));
      }
    });
    prevPath = p;
    prevEnd = r;
    i = r + 1;
  }
  return edits;
}

// ---------- V4A patches (SPEC section 8) ----------

/** One body line of a V4A chunk. `blank` marks a line whose patch line was blank (empty or only whitespace). */
interface VBody {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  blank: boolean;
}
interface VChunk {
  anchor: string | null;
  body: VBody[];
  eof: boolean;
}

/** Split a chunk body into O (context and `-` lines) and N (context and `+` lines), in body order. */
function chunkON(ch: VChunk): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const b of ch.body) {
    if (b.kind === 'ctx') {
      N.push({ text: b.text, ctx: O.length });
      O.push(b.text);
    } else if (b.kind === 'old') O.push(b.text);
    else if (b.kind === 'new') N.push({ text: b.text, ctx: null });
  }
  return { O, N };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const p = line.slice('*** Add File: '.length).trim();
      const items: { text: string; blank: boolean }[] = [];
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j]!)) {
        const l = lines[j]!;
        if (l.startsWith('+')) items.push({ text: l.slice(1), blank: false });
        else if (l === '') items.push({ text: '', blank: true });
        else throw new Exit2(`error: parse ${j + 1}`);
        j++;
      }
      // Blank lines at the end of a section are not part of it.
      while (items.length > 0 && items[items.length - 1]!.blank) items.pop();
      const fileLines = items.map((x) => x.text);
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, writeDoc({ br: '\n', lines: fileLines, final: true }));
      });
      i = j;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const p = line.slice('*** Delete File: '.length).trim();
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j]!)) {
        if (!blank(lines[j]!)) throw new Exit2(`error: parse ${j + 1}`);
        j++;
      }
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      i = j;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const p = line.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      let j = i + 1;
      let moveTo: string | null = null;
      if (j < last && lines[j]!.startsWith('*** Move to: ')) {
        moveTo = lines[j]!.slice('*** Move to: '.length).trim();
        j++;
      }
      const chunks: VChunk[] = [];
      let curChunk: VChunk | null = null;
      let anyChunk = false;
      const closeChunk = (): void => {
        if (curChunk !== null) {
          chunks.push(curChunk);
          curChunk = null;
        }
      };
      while (j < last && !isSectionStart(lines[j]!)) {
        const l = lines[j]!;
        if (l === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${j + 1}`);
          curChunk.eof = true;
          closeChunk();
          j++;
          continue;
        }
        if (l.startsWith('@@')) {
          closeChunk();
          const anchor = l.slice(2).trim();
          curChunk = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          anyChunk = true;
          j++;
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (curChunk === null) {
            if (anyChunk) {
              // A blank line between chunks is a separator; any other body line here has no chunk to join.
              if (!blank(l)) throw new Exit2(`error: parse ${j + 1}`);
              j++;
              continue;
            }
            curChunk = { anchor: null, body: [], eof: false };
            anyChunk = true;
          }
          if (l === '') curChunk.body.push({ kind: 'ctx', text: '', blank: true });
          else if (l.startsWith(' ')) curChunk.body.push({ kind: 'ctx', text: l.slice(1), blank: blank(l) });
          else if (l.startsWith('-')) curChunk.body.push({ kind: 'old', text: l.slice(1), blank: false });
          else curChunk.body.push({ kind: 'new', text: l.slice(1), blank: false });
          j++;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      // Blank lines at the end of a section are not part of it.
      if (curChunk !== null) {
        while (curChunk.body.length > 0 && curChunk.body[curChunk.body.length - 1]!.blank) curChunk.body.pop();
      }
      closeChunk();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const cur = tree.get(p);
        if (cur === null) throw new Fail('missing', p);
        if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        let doc = parseDoc(cur);
        let cursor = 0;
        for (const ch of chunks) {
          // SPEC section 8: a chunk with an anchor first finds the first line at or after the cursor equal
          // to the anchor, else no-match; the cursor moves past it. O is then taken at or after the cursor,
          // and an insertion-only chunk inserts at the cursor.
          if (ch.anchor !== null) {
            const found = findMatch([ch.anchor], doc.lines, strict, cursor);
            if (found === null) throw new Fail('no-match', p);
            cursor = found.positions[0]! + 1;
          }
          const searchFrom = cursor;
          const insertAt = cursor;
          const { O, N } = chunkON(ch);
          if (O.length === 0) {
            const at = ch.eof ? doc.lines.length : insertAt;
            doc.lines = applyReplace(doc.lines, [], N, at, 0);
            cursor = at + N.length;
          } else {
            const found = findMatch(O, doc.lines, strict, searchFrom);
            if (found === null) throw new Fail('no-match', p);
            let at: number | null = null;
            for (const pos of found.positions) {
              if (ch.eof && pos + O.length !== doc.lines.length) continue;
              at = pos;
              break;
            }
            if (at === null) throw new Fail('no-match', p);
            doc.lines = applyReplace(doc.lines, O, N, at, found.tier);
            cursor = at + N.length;
          }
        }
        const out = writeDoc(doc);
        if (moveTo !== null) {
          tree.now.set(p, null);
          tree.now.set(moveTo, out);
          tree.recordMove(p, moveTo);
        } else {
          tree.now.set(p, out);
        }
      });
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...beforeMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // One line for each path whose state changed, in byte order of the paths (UTF-8); a move is one R line that
  // replaces its D and A lines and sorts by its new path. A file whose bytes are unchanged is not listed.
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.set(p, { was, now });
  }
  const rows: Array<{ key: string; line: string }> = [];
  const moved = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const o = changed.get(oldP);
    const n = changed.get(newP);
    if (
      o !== undefined &&
      o.was !== null &&
      o.now === null &&
      n !== undefined &&
      n.was === null &&
      n.now !== null
    ) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      moved.add(oldP);
      moved.add(newP);
    }
  }
  for (const [p, c] of changed) {
    if (moved.has(p)) continue;
    rows.push({ key: p, line: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    // Delete first, then write, so a move into a path that held a file still works. The set of paths to
    // touch is exactly `changed`, the same set the rows above were built from.
    const sorted = [...changed.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    for (const p of sorted) {
      if (changed.get(p)!.now === null) rmSync(p, { force: true });
    }
    for (const p of sorted) {
      const now = changed.get(p)!.now;
      if (now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
