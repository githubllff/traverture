import { requestUrl } from 'obsidian';
// @ts-ignore
import * as wasmModule from './engine.js';
import { getLangSuffix } from './languages';
import { VerseData } from './types';
import { VaultOfflineEpubRepository } from './VaultOfflineEpubRepository';

const CACHE_TTL_MS = 60 * 60 * 1000;

interface CacheEntry {
    data: VerseData;
    ts: number;
}

const verseCache = new Map<string, CacheEntry>();

function isCacheFresh(entry: CacheEntry): boolean {
    return Date.now() - entry.ts < CACHE_TTL_MS;
}

function getCachedVerse(key: string): VerseData | null {
    const entry = verseCache.get(key);
    if (entry && isCacheFresh(entry)) return entry.data;
    if (entry) verseCache.delete(key);
    return null;
}

function setCachedVerse(key: string, data: VerseData): void {
    verseCache.set(key, { data, ts: Date.now() });
}

export async function fetchVerseWithExtras(range: string, langCode: string, signal?: AbortSignal): Promise<VerseData | null> {
    if (signal?.aborted) return null;

    const cacheKey = `${langCode}:${range}:extras`;
    const cached = getCachedVerse(cacheKey);
    if (cached) return cached;

    const suffix = getLangSuffix(langCode);
    const rangeParts = range.split('-');
    const apiRange = rangeParts.map(p => {
        const book = p.substring(0, 2).replace(/^0+/, '');
        return book + p.substring(2);
    }).join('-');
    const url = `https://www.jw.org/${suffix}json/html/${apiRange}`;

    try {
        const response = await requestUrl({ url });
        if (signal?.aborted) return null;

        const data = response.json;
        const verseData = data.ranges?.[apiRange];
        if (verseData) {
            if (signal?.aborted) return null;
            const result: VerseData = {
                html: cleanVerseHtml(verseData.html, true),
                citation: (verseData.citation || '').replace(/&nbsp;/g, ' ').replace(/\u00A0/g, ' '),
                footnotes: verseData.footnotes || [],
                crossReferences: verseData.crossReferences || [],
                commentaries: verseData.commentaries?.filter((c: any) => c.content) || [],
            };
            setCachedVerse(cacheKey, result);
            return result;
        }
    } catch (e) {
        if (signal?.aborted) return null;
        console.error(`tra.VER:ture: Error fetching verse "${apiRange}":`, e);
    }
    return null;
}

function cleanVerseHtml(rawHtml: string, keepMarkers: boolean = false): string {
    let cleaned = rawHtml;
    
    if (keepMarkers) {
        cleaned = cleaned.replace(/<a class="footnoteLink"[^>]*id="footnotesource(\d+)"[^>]*>\*<\/a>/g, 
            '<sup class="traverture-footnote-marker" data-fn-id="$1">*</sup>');
        cleaned = cleaned.replace(/<a class="xrefLink jsBibleLink"[^>]*id="xreflink(\d+)"[^>]*>\+<\/a>/g,
            '<sup class="traverture-xref-marker" data-xref-id="$1">+</sup>');
    }

    cleaned = cleaned
        .replace(/<a[^>]*>/g, '')
        .replace(/<\/a>/g, '')
        .replace(/\r\n/g, '')
        .replace(/\u00A0/g, ' ')
        .replace(/\u202F/g, ' ');

    if (!keepMarkers) {
        cleaned = cleaned.replace(/\+/g, '').replace(/\*/g, '');
    }

    cleaned = cleaned.replace(/class="style-b first"/g, 'class=""');
    cleaned = cleaned.replace(/class="style-b"/g, 'class=""');
    cleaned = cleaned.replace(/<span class="verse" id="[^"]*">/g, '<span class="verse">');
    cleaned = cleaned.replace(/class=""/g, '');

    if (!cleaned.includes('superscription')) {
        cleaned = '<sup class="superscription"><span class="style-w"> </span></sup>' + cleaned;
    }

    return cleaned;
}

export function escapeHtml(text: string): string {
    const div = activeDocument.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

export async function fetchVerse(range: string, langCode: string): Promise<VerseData | null> {
    const cacheKey = `${langCode}:${range}`;
    const cached = getCachedVerse(cacheKey);
    if (cached) return cached;

    const suffix = getLangSuffix(langCode);
    const rangeParts = range.split('-');
    const apiRange = rangeParts.map(p => {
        const book = p.substring(0, 2).replace(/^0+/, '');
        return book + p.substring(2);
    }).join('-');
    const url = `https://www.jw.org/${suffix}json/html/${apiRange}`;

    try {
        const response = await requestUrl({ url });
        const data = response.json;
        const verseData = data.ranges?.[apiRange];
        if (verseData) {
            const result: VerseData = {
                html: cleanVerseHtml(verseData.html),
                citation: (verseData.citation || '').replace(/&nbsp;/g, ' ').replace(/\u00A0/g, ' '),
            };
            setCachedVerse(cacheKey, result);
            return result;
        }
    } catch (e) {
        console.error(`tra.VER:ture: Error fetching verse "${apiRange}":`, e);
    }
    return null;
}

interface AslTimecodes {
    startTime: string;
    endTime: string;
}

const aslMetaCache = new Map<string, AslTimecodes>();

export async function fetchAslTimecodes(bookNum: number, chapter: number, startVerse: number, endVerse: number): Promise<string | null> {
    const cacheKey = `asl:${bookNum}:${chapter}`;
    const cached = aslMetaCache.get(cacheKey);
    if (cached) {
        return `${cached.startTime}-${cached.endTime}`;
    }

    try {
        const url = wasmModule.TravertureEngine.get_asl_metadata_url(bookNum, chapter);
        const response = await requestUrl({ url });
        const data = response.json;
        const fileFormats = data.files?.ASL;
        if (!fileFormats) return null;

        let markers;
        for (const format of Object.values(fileFormats)) {
            const files = format as Array<{ markers?: { markers?: Array<{ verseNumber: number; startTime: string; duration: string }> } }>;
            for (const file of files) {
                if (file.markers?.markers) {
                    markers = file.markers.markers;
                    break;
                }
            }
            if (markers) break;
        }
        if (!markers) return null;

        const firstMarker = markers.find((m: any) => m.verseNumber === startVerse);
        const lastMarker = markers.find((m: any) => m.verseNumber === endVerse);
        if (!firstMarker || !lastMarker) return null;

        const startSeconds = parseTimecode(firstMarker.startTime);
        const endSeconds = parseTimecode(lastMarker.startTime) + parseTimecode(lastMarker.duration);
        const startTime = formatTimecode(startSeconds);
        const endTime = formatTimecode(endSeconds);

        aslMetaCache.set(cacheKey, { startTime, endTime });
        return `${startTime}-${endTime}`;
    } catch (e) {
        console.error('tra.VER:ture: Error fetching ASL metadata:', e);
        return null;
    }
}

function parseTimecode(tc: string): number {
    const parts = tc.split(':');
    return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
}

function formatTimecode(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export async function getAslTimecodes(bcv: string): Promise<string | undefined> {
    const parts = bcv.split('-');
    const startBcv = parts[0];
    const endBcv = parts.length > 1 ? parts[1] : parts[0];
    const bookNum = parseInt(startBcv.substring(0, 2));
    const chapter = parseInt(startBcv.substring(2, 5));
    const startVerse = parseInt(startBcv.substring(5, 8));
    const endVerse = parseInt(endBcv.substring(5, 8));
    const result = await fetchAslTimecodes(bookNum, chapter, startVerse, endVerse);
    return result ?? undefined;
}

function parseBcvPart(bcv: string): { book: number; chapter: number; verse: number } {
    return {
        book: parseInt(bcv.substring(0, 2), 10),
        chapter: parseInt(bcv.substring(2, 5), 10),
        verse: parseInt(bcv.substring(5, 8), 10),
    };
}

function buildOfflineCitation(range: string): string {
    const [startRaw, endRaw] = range.includes('-') ? range.split('-') : [range, range];
    const start = parseBcvPart(startRaw);
    const end = parseBcvPart(endRaw);
    if (start.book === end.book && start.chapter === end.chapter && start.verse === end.verse) {
        return `${start.chapter}:${start.verse}`;
    }
    if (start.book === end.book && start.chapter === end.chapter) {
        return `${start.chapter}:${start.verse}-${end.verse}`;
    }
    return `${start.chapter}:${start.verse}-${end.chapter}:${end.verse}`;
}

export async function fetchVerseWithExtrasOfflineFirst(
    range: string,
    langCode: string,
    offlineRepo: VaultOfflineEpubRepository | null | undefined,
    signal?: AbortSignal
): Promise<VerseData | null> {
    if (signal?.aborted) return null;

    if (offlineRepo) {
        try {
            const [startRaw, endRaw] = range.includes('-') ? range.split('-') : [range, range];
            const start = parseBcvPart(startRaw);
            const end = parseBcvPart(endRaw);

            if (start.book === end.book && start.chapter === end.chapter) {
                const text = await offlineRepo.getVerseRange(langCode, start.book, start.chapter, start.verse, end.verse);
                if (text) {
                    return {
                        html: `<p>${text}</p>`,
                        citation: buildOfflineCitation(range),
                        footnotes: [],
                        crossReferences: [],
                        commentaries: [],
                    };
                }
            }
        } catch (_) {
        }
    }

    return fetchVerseWithExtras(range, langCode, signal);
}
