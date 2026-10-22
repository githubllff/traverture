import { fetchVerseWithExtrasOfflineFirst, getAslTimecodes } from './cache';
import { VerseModal } from './modal';
import { ViewPlugin, Decoration } from '@codemirror/view';
import { augmentClauses } from './relativeRefs';
import { findWolTriggers, buildWolSearchUrl, openExternalUrl } from './wolSearch';
import { getAvailableLanguages } from './languages';
import { RangeSetBuilder } from '@codemirror/state';

const REF_PATTERN = /\{\{(.+?)\}\}/g;

function buildDecorations(view: any, plugin: any) {
    const allDecos: Array<{ from: number; to: number; deco: any }> = [];
    const cursor = view.state.selection.main;
    const bcvs: Array<{ from: number; to: number; bcv: string }> = [];

    for (const { from, to } of view.visibleRanges) {
        const text = view.state.doc.sliceString(from, to);
        const decorated: Array<{ from: number; to: number }> = [];
        let match;
        while ((match = REF_PATTERN.exec(text)) !== null) {
            const blockStart = from + match.index;
            const blockEnd = blockStart + match[0].length;
            const innerStart = blockStart + 2;
            const innerEnd = blockEnd - 2;
            if (cursor.from <= blockEnd && cursor.to >= blockStart) continue;
            allDecos.push({ from: blockStart, to: innerStart, deco: Decoration.replace({}) });
            allDecos.push({ from: innerEnd, to: blockEnd, deco: Decoration.replace({}) });
            decorated.push({ from: blockStart, to: innerStart });
            decorated.push({ from: innerEnd, to: blockEnd });
            const innerText = match[1];
            const cleanMatch = match[0].replace(/\*\*/g, '').replace(/\*/g, '');
            const engineInput = cleanMatch.replace('{{', '⟪⟪').replace('}}', '⟫⟫');
            const parsed = plugin.safeParse?.(engineInput);
            if (!parsed) continue;
            let clauses: Array<[string, number, number, string[][]]> = JSON.parse(parsed);
            clauses = augmentClauses(engineInput, clauses);
            const sorted = [...clauses].sort((a, b) => b[0].length - a[0].length);
            for (const clause of sorted) {
                const [clauseText, , , ranges] = clause;
                if (ranges.length === 0) continue;
                const bcv = ranges[0][0] === ranges[0][1] ? ranges[0][0] : `${ranges[0][0]}-${ranges[0][1]}`;
                const escaped = clauseText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const refRegex = new RegExp(escaped, 'g');
                let refMatch;
                while ((refMatch = refRegex.exec(innerText)) !== null) {
                    const refStart = innerStart + refMatch.index;
                    const refEnd = refStart + clauseText.length;
                    const overlaps = decorated.some(p => refStart < p.to && refEnd > p.from);
                    if (!overlaps) {
                        allDecos.push({ from: refStart, to: refEnd, deco: Decoration.mark({ class: 'cm-traverture-ref' }) });
                        decorated.push({ from: refStart, to: refEnd });
                        bcvs.push({ from: refStart, to: refEnd, bcv });
                    }
                }
            }
        }
        if (plugin.settings.autoDetect) {
            const decoratedRanges = [...decorated].sort((a, b) => a.from - b.from);
            let pos = from;
            for (const d of decoratedRanges) {
                if (pos < d.from) processSegment(pos, view.state.doc.sliceString(pos, d.from), plugin, allDecos, decorated, bcvs);
                pos = Math.max(pos, d.to);
            }
            if (pos < to) processSegment(pos, view.state.doc.sliceString(pos, to), plugin, allDecos, decorated, bcvs);
        }
    }
    if (plugin.settings?.enableWolSearch !== false) {
        for (const { from, to } of view.visibleRanges) {
            const rangeText = view.state.doc.sliceString(from, to);
            const triggers = findWolTriggers(rangeText);
            for (const t of triggers) {
                allDecos.push({
                    from: from + t.start,
                    to: from + t.end,
                    deco: Decoration.mark({
                        class: 'cm-traverture-wol-link',
                        attributes: { 'data-wol-query': t.query },
                    }),
                });
            }
        }
    }

    allDecos.sort((a, b) => a.from - b.from);
    const builder: any = new RangeSetBuilder();
    for (const d of allDecos) builder.add(d.from, d.to, d.deco);
    plugin._editBcvs = bcvs;
    return builder.finish();
}

function processSegment(basePos: number, segment: string, plugin: any, allDecos: Array<{ from: number; to: number; deco: any }>, decorated: Array<{ from: number; to: number }>, bcvs: Array<{ from: number; to: number; bcv: string }>) {
    const parsed = plugin.safeParse?.(segment);
    if (!parsed) return;
    let clauses: Array<[string, number, number, string[][]]> = JSON.parse(parsed);
    clauses = augmentClauses(segment, clauses);
    if (clauses.length === 0) return;
    for (const clause of clauses) {
        const [, startPos, endPos, ranges] = clause;
        if (ranges.length === 0) continue;
        const bcv = ranges[0][0] === ranges[0][1] ? ranges[0][0] : `${ranges[0][0]}-${ranges[0][1]}`;
        const refStart = basePos + startPos;
        const refEnd = basePos + endPos;
        const overlaps = decorated.some(p => refStart < p.to && refEnd > p.from);
        if (!overlaps) {
            allDecos.push({ from: refStart, to: refEnd, deco: Decoration.mark({ class: 'cm-traverture-ref' }) });
            decorated.push({ from: refStart, to: refEnd });
            bcvs.push({ from: refStart, to: refEnd, bcv });
        }
    }
}

export function createTravertureEditorPlugin(plugin: any) {
    plugin._editBcvs = [];
    return ViewPlugin.fromClass(
        class {
            decorations: any;
            constructor(view: any) { this.decorations = buildDecorations(view, plugin); }
            update(update: any) {
                if (update.docChanged || update.selectionSet || update.viewportChanged) this.decorations = buildDecorations(update.view, plugin);
            }
        },
        {
            decorations: (v: any) => v.decorations,
            eventHandlers: {
                mousedown: (e: MouseEvent, _view: any) => {
                    if (e.button !== 0) return;
                    const target = e.target as HTMLElement;
                    const wolEl = target?.closest?.('.cm-traverture-wol-link');
                    if (wolEl) {
                        const query = wolEl.getAttribute('data-wol-query');
                        if (query) {
                            e.preventDefault();
                            e.stopPropagation();
                            const url = buildWolSearchUrl(plugin.settings, query);
                            openExternalUrl(url);
                            return;
                        }
                    }
                    const pos = _view.posAtCoords({ x: e.clientX, y: e.clientY });
                    if (pos === null) return;
                    const entry = plugin._editBcvs?.find((b: any) => pos > b.from && pos < b.to);
                    if (entry) {
                        e.preventDefault();
                        e.stopPropagation();
                        void (async () => {
                            if (await openExternalReference(plugin, entry.bcv)) return;
                            await showModal(plugin, entry.bcv);
                        })();
                    }
                }
            }
        }
    );
}

async function openExternalReference(plugin: any, bcv: string): Promise<boolean> {
    const scheme = plugin.settings.linkScheme ?? 'popup';
    if (scheme !== 'jwlibrary' && scheme !== 'jworg') return false;
    const langObj = getAvailableLanguages().find(l => l.code === plugin.settings.outputLanguage);
    const langSymbol = langObj ? plugin.engine.constructor.get_lang_symbol(plugin.settings.outputLanguage) : 'E';
    const timecodes = plugin.settings.outputLanguage === 'ase' ? await getAslTimecodes(bcv) : undefined;
    const query = timecodes ? `?wtlocale=${langSymbol}&bible=${bcv}&ts=${timecodes}` : `?wtlocale=${langSymbol}&bible=${bcv}`;
    const url = scheme === 'jwlibrary' ? `jwlibrary:///finder${query}` : `https://www.jw.org/finder${query}`;
    try {
        const maybeRequire = (window as any).require;
        if (maybeRequire) {
            const { shell } = maybeRequire('electron');
            await shell.openExternal(url);
        } else {
            window.open(url, '_blank', 'noopener');
        }
        return true;
    } catch (error) {
        console.error('Failed to open external scripture link:', error);
        return false;
    }
}

async function showModal(plugin: any, bcv: string): Promise<void> {
    const parts = bcv.split('-');
    const startBcv = parts[0];
    const endBcv = parts.length > 1 ? parts[1] : parts[0];
    const fmtEngine = new (plugin.engine.constructor)(plugin.settings.sourceLanguage, plugin.settings.outputLanguage, plugin.settings.titleFormat, false);
    const decoded = JSON.parse(fmtEngine.decode_scriptures(JSON.stringify([[startBcv, endBcv]])));
    const displayText = decoded[0] || bcv;
    const timecodes = plugin.settings.outputLanguage === 'ase' ? await getAslTimecodes(bcv) : undefined;
    const modal = new VerseModal();
    modal.show({ html: `<p><em>Loading...</em></p>`, citation: displayText }, bcv, plugin.settings.outputLanguage, displayText, timecodes);
    void fetchVerseWithExtrasOfflineFirst(bcv, plugin.settings.outputLanguage, plugin.offlineRepo, modal.getSignal()).then(verseData => {
        if (!modal.isVisible()) return;
        modal.show(verseData || { html: `<p><em>Verse lookup unavailable</em></p>`, citation: displayText }, bcv, plugin.settings.outputLanguage, displayText, timecodes);
    });
}
