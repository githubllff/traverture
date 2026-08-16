import { fetchVerseWithExtras, getAslTimecodes } from './cache';
import { VerseModal } from './modal';
import { ViewPlugin, Decoration } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';

const REF_PATTERN = /\{\{(.+?)\}\}/g;

function buildDecorations(view: any, plugin: any) {
    const allDecos: Array<{ from: number; to: number; deco: any }> = [];
    const cursor = view.state.selection.main;
    const bcvs: Array<{ from: number; to: number; bcv: string }> = [];

    for (const { from, to } of view.visibleRanges) {
        const text = view.state.doc.sliceString(from, to);
        const decorated: Array<{ from: number; to: number }> = [];
        let match: RegExpExecArray | null;
        REF_PATTERN.lastIndex = 0;
        while ((match = REF_PATTERN.exec(text)) !== null) {
            const blockStart = from + match.index;
            const blockEnd = blockStart + match[0].length;
            const innerStart = blockStart + 2;
            const innerEnd = blockEnd - 2;
            if (cursor.from <= blockEnd && cursor.to >= blockStart) continue;
            allDecos.push({ from: blockStart, to: innerStart, deco: Decoration.replace({}) });
            allDecos.push({ from: innerEnd, to: blockEnd, deco: Decoration.replace({}) });
            decorated.push({ from: blockStart, to: innerStart }, { from: innerEnd, to: blockEnd });
            const parsed = plugin.safeParse?.(match[0].replace(/\*\*/g, '').replace(/\*/g, '').replace('{{', '⟪⟪').replace('}}', '⟫⟫'));
            if (!parsed) continue;
            const clauses: Array<[string, number, number, string[][]]> = JSON.parse(parsed);
            for (const [clauseText, , , ranges] of clauses) {
                if (!ranges.length) continue;
                const bcv = ranges[0][0] === ranges[0][1] ? ranges[0][0] : `${ranges[0][0]}-${ranges[0][1]}`;
                const regex = new RegExp(clauseText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
                let refMatch: RegExpExecArray | null;
                while ((refMatch = regex.exec(match[1])) !== null) {
                    const refStart = innerStart + refMatch.index;
                    const refEnd = refStart + clauseText.length;
                    if (!decorated.some(p => refStart < p.to && refEnd > p.from)) {
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
    allDecos.sort((a, b) => a.from - b.from);
    const builder: any = new RangeSetBuilder();
    for (const d of allDecos) builder.add(d.from, d.to, d.deco);
    plugin._editBcvs = bcvs;
    return builder.finish();
}

function processSegment(basePos: number, segment: string, plugin: any, allDecos: Array<{ from: number; to: number; deco: any }>, decorated: Array<{ from: number; to: number }>, bcvs: Array<{ from: number; to: number; bcv: string }>) {
    const parsed = plugin.safeParse?.(segment);
    if (!parsed) return;
    const clauses: Array<[string, number, number, string[][]]> = JSON.parse(parsed);
    for (const [, startPos, endPos, ranges] of clauses) {
        if (!ranges.length) continue;
        const bcv = ranges[0][0] === ranges[0][1] ? ranges[0][0] : `${ranges[0][0]}-${ranges[0][1]}`;
        const refStart = basePos + startPos;
        const refEnd = basePos + endPos;
        if (!decorated.some(p => refStart < p.to && refEnd > p.from)) {
            allDecos.push({ from: refStart, to: refEnd, deco: Decoration.mark({ class: 'cm-traverture-ref' }) });
            decorated.push({ from: refStart, to: refEnd });
            bcvs.push({ from: refStart, to: refEnd, bcv });
        }
    }
}

export function createTravertureEditorPlugin(plugin: any) {
    plugin._editBcvs = [];
    return ViewPlugin.fromClass(class {
        decorations: any;
        constructor(view: any) { this.decorations = buildDecorations(view, plugin); }
        update(update: any) {
            if (update.docChanged || update.selectionSet || update.viewportChanged) this.decorations = buildDecorations(update.view, plugin);
        }
    }, {
        decorations: (value: any) => value.decorations,
        eventHandlers: {
            mousedown: (event: MouseEvent, view: any) => {
                if (event.button !== 0) return;
                const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
                if (pos === null) return;
                const entry = plugin._editBcvs?.find((item: any) => pos > item.from && pos < item.to);
                if (!entry) return;

                const scheme = plugin.settings.linkScheme ?? 'popup';
                if (scheme === 'jwlibrary') {
                    const langSymbol = plugin.engine.constructor.get_lang_symbol(plugin.settings.outputLanguage);
                    const url = `jwlibrary:///finder?wtlocale=${langSymbol}&bible=${entry.bcv}`;
                    event.preventDefault();
                    event.stopPropagation();
                    window.open(url, '_blank');
                    return;
                }

                if (event.ctrlKey || event.metaKey) {
                    const langSymbol = plugin.engine.constructor.get_lang_symbol(plugin.settings.outputLanguage);
                    window.open(`jwlibrary:///finder?wtlocale=${langSymbol}&bible=${entry.bcv}`, '_blank');
                    return;
                }

                event.preventDefault();
                event.stopPropagation();
                void showModal(plugin, entry.bcv);
            }
        }
    });
}

async function showModal(plugin: any, bcv: string): Promise<void> {
    const parts = bcv.split('-');
    const startBcv = parts[0];
    const endBcv = parts.length > 1 ? parts[1] : parts[0];
    const fmtEngine = new plugin.engine.constructor(plugin.settings.sourceLanguage, plugin.settings.outputLanguage, plugin.settings.titleFormat, false);
    const decoded = JSON.parse(fmtEngine.decode_scriptures(JSON.stringify([[startBcv, endBcv]])));
    const displayText = decoded[0] || bcv;
    const timecodes = plugin.settings.outputLanguage === 'ase' ? await getAslTimecodes(bcv) : undefined;
    const modal = new VerseModal();
    modal.show({ html: '<p><em>Loading...</em></p>', citation: displayText }, bcv, plugin.settings.outputLanguage, displayText, timecodes);
    void fetchVerseWithExtras(bcv, plugin.settings.outputLanguage, modal.getSignal()).then(verseData => {
        if (!modal.isVisible()) return;
        modal.show(verseData || { html: '<p><em>Verse lookup unavailable</em></p>', citation: displayText }, bcv, plugin.settings.outputLanguage, displayText, timecodes);
    });
}
