// Helpers for resolving "relative" scripture references such as "v2" or "2:1"
// against a previously mentioned book/chapter in the same text.

export type Clause = [string, number, number, string[][]];

export interface AugmentResult {
    clauses: Clause[];
    lastBook: number;
    lastChapter: number;
}

function toBcv(book: number, chapter: number, verse: number): string {
    return `${String(book).padStart(2, '0')}${String(chapter).padStart(3, '0')}${String(verse).padStart(3, '0')}`;
}

function parseRange(s: string): [number, number] {
    const parts = s.split('-');
    const a = parseInt(parts[0], 10);
    const b = parts.length > 1 ? parseInt(parts[1], 10) : a;
    return [a, b];
}

export function augmentClausesWithState(
    text: string,
    clauses: Clause[],
    initialBook: number = -1,
    initialChapter: number = -1
): AugmentResult {
    if (!clauses || clauses.length === 0) {
        // Still scan for relative refs using initial state.
        clauses = [];
    }

    const absIntervals = clauses.map(c => [c[1], c[2]] as [number, number]);
    const overlapsAbs = (s: number, e: number) =>
        absIntervals.some(([a, b]) => s < b && e > a);

    interface Cand {
        start: number;
        end: number;
        kind: 'v' | 'c';
        payload: string;
    }
    const candidates: Cand[] = [];

    const vRegex = /\bv\.?\s*(\d+(?:-\d+)?)\b/gi;
    let m: RegExpExecArray | null;
    while ((m = vRegex.exec(text)) !== null) {
        candidates.push({ start: m.index, end: m.index + m[0].length, kind: 'v', payload: m[1] });
    }
    const verseWordRegex = /\bverses?\s+(\d+(?:-\d+)?)\b/gi;
    while ((m = verseWordRegex.exec(text)) !== null) {
        candidates.push({ start: m.index, end: m.index + m[0].length, kind: 'v', payload: m[1] });
    }
    const cRegex = /\b(\d{1,3}):(\d{1,3}(?:-\d{1,3})?)\b/g;
    while ((m = cRegex.exec(text)) !== null) {
        const ch = parseInt(m[1], 10);
        if (ch < 1 || ch > 150) continue;
        candidates.push({ start: m.index, end: m.index + m[0].length, kind: 'c', payload: `${m[1]}:${m[2]}` });
    }

    candidates.sort((a, b) => a.start - b.start);
    const chosen: Cand[] = [];
    for (const c of candidates) {
        if (overlapsAbs(c.start, c.end)) continue;
        if (chosen.some(x => c.start < x.end && c.end > x.start)) continue;
        chosen.push(c);
    }

    interface AbsItem { start: number; end: number; book: number; chapter: number; }
    const absItems: AbsItem[] = clauses.map(c => {
        const bcv = (c[3] && c[3][0] && c[3][0][0]) ? c[3][0][0] : '';
        return {
            start: c[1],
            end: c[2],
            book: bcv ? parseInt(bcv.substring(0, 2), 10) : -1,
            chapter: bcv ? parseInt(bcv.substring(2, 5), 10) : -1,
        };
    });

    type Merged =
        | { type: 'abs'; start: number; end: number; book: number; chapter: number }
        | { type: 'rel'; start: number; end: number; kind: 'v' | 'c'; payload: string };

    const merged: Merged[] = [
        ...absItems.map(a => ({ type: 'abs' as const, start: a.start, end: a.end, book: a.book, chapter: a.chapter })),
        ...chosen.map(c => ({ type: 'rel' as const, start: c.start, end: c.end, kind: c.kind, payload: c.payload })),
    ].sort((a, b) => a.start - b.start);

    let lastBook = initialBook;
    let lastChapter = initialChapter;
    const synthetic: Clause[] = [];

    for (const item of merged) {
        if (item.type === 'abs') {
            if (item.book > 0) lastBook = item.book;
            if (item.chapter > 0) lastChapter = item.chapter;
            continue;
        }
        if (lastBook <= 0 || lastChapter <= 0) continue;

        const originalText = text.substring(item.start, item.end);
        let bcv = '';
        if (item.kind === 'v') {
            const [sv, ev] = parseRange(item.payload);
            const startBcv = toBcv(lastBook, lastChapter, sv);
            const endBcv = toBcv(lastBook, lastChapter, ev);
            bcv = startBcv === endBcv ? startBcv : `${startBcv}-${endBcv}`;
        } else {
            const [chapStr, verseStr] = item.payload.split(':');
            const chapter = parseInt(chapStr, 10);
            const [sv, ev] = parseRange(verseStr);
            const startBcv = toBcv(lastBook, chapter, sv);
            const endBcv = toBcv(lastBook, chapter, ev);
            bcv = startBcv === endBcv ? startBcv : `${startBcv}-${endBcv}`;
            lastChapter = chapter;
        }

        synthetic.push([originalText, item.start, item.end, [[bcv, bcv]]]);
    }

    const allClauses = [...clauses, ...synthetic].sort((a, b) => a[1] - b[1]);

    return { clauses: allClauses, lastBook, lastChapter };
}

export function augmentClauses(text: string, clauses: Clause[]): Clause[] {
    return augmentClausesWithState(text, clauses, -1, -1).clauses;
}