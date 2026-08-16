import { Plugin, WorkspaceLeaf, Notice, Menu, MarkdownView } from 'obsidian';
// @ts-ignore
import wasmBinary from './engine_bg.wasm';
// @ts-ignore
import * as wasmModule from './engine.js';
import { fetchVerseWithExtras, getAslTimecodes } from './cache';
import { createTravertureEditorPlugin } from './editor';
import { getAvailableLanguages } from './languages';
import { VerseModal } from './modal';
import { TravertureSettingTab } from './settings';
import { TravertureSidebarView } from './sidebar';
import { DEFAULT_SETTINGS, VIEW_TYPE_TRAVERTURE_SIDEBAR, SidebarRef } from './types';

export default class TraverturePlugin extends Plugin {
    settings = DEFAULT_SETTINGS;
    engine: any = null;
    private processingElements = new Set<HTMLElement>();

    async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
    async saveSettings() { await this.saveData(this.settings); }

    createEngine() {
        try {
            this.engine = new wasmModule.TravertureEngine(this.settings.sourceLanguage, this.settings.outputLanguage, 'full', false);
        } catch (e) { console.error('tra.VER:ture: Failed to create engine:', e); }
    }

    private parseGuard = false;

    safeParse(text: string): string | null {
        return this.engine.parse(
            this.settings.sourceLanguage,
            this.settings.outputLanguage,
            'full',
            false,
            text
        );
    }

    private stripFrontmatter(content: string): string {
        if (content.startsWith('---')) {
            const endIndex = content.indexOf('---', 3);
            if (endIndex !== -1) {
                return content.substring(endIndex + 3);
            }
        }
        return content;
    }

    async parseReferences(text: string): Promise<SidebarRef[]> {
        const results: SidebarRef[] = [];
        if (!this.engine) return results;

        text = this.stripFrontmatter(text);
        const engineText = text.replace(/\{\{(.+?)\}\}/g, '⟪$1⟫');
        const parsed = this.safeParse(engineText);
        if (!parsed) return results;

        const clauses: Array<[string, number, number, string[][]]> = JSON.parse(parsed);
        if (clauses.length === 0) return results;

        const engFull = new wasmModule.TravertureEngine('en', 'en', 'full', false);
        const engStd = new wasmModule.TravertureEngine('en', 'en', 'standard', false);
        const engOff = new wasmModule.TravertureEngine('en', 'en', 'official', false);

        for (const [clauseText] of clauses) {
            const ranges = clauses.find(c => c[0] === clauseText)?.[3] || [];
            if (ranges.length === 0) continue;
            
            for (const range of ranges) {
                const singleRange = [[range[0], range[1]]];
                const rangeJson = JSON.stringify(singleRange);
                const fullDecoded = JSON.parse(engFull.decode_scriptures(rangeJson));
                const stdDecoded = JSON.parse(engStd.decode_scriptures(rangeJson));
                const offDecoded = JSON.parse(engOff.decode_scriptures(rangeJson));
                const startBcv = range[0], endBcv = range[1];
                const bookNum = parseInt(startBcv.substring(0, 2));

                results.push({
                    scripture: clauseText,
                    fullRef: fullDecoded[0] || clauseText,
                    standardRef: stdDecoded[0] || '',
                    officialRef: offDecoded[0] || '',
                    startBcv, endBcv,
                    startCh: parseInt(startBcv.substring(2, 5)),
                    endCh: parseInt(endBcv.substring(2, 5)),
                    startVerse: parseInt(startBcv.substring(5, 8)),
                    endVerse: parseInt(endBcv.substring(5, 8)),
                    bookNum,
                });
            }
        }
        return results;
    }

    processElement(el: HTMLElement) {
        if (el.querySelector('.callout, svg')) return;
        if (this.processingElements.has(el)) return;
        this.processingElements.add(el);
        let html = el.innerHTML;

        // Process {{ }} blocks (forced parsing)
        if (/\{\{(.+?)\}\}/g.test(html)) {
            html = html.replace(/\{\{(.+?)\}\}/g, (_fullMatch: string, inner: string) => {
                if (!this.engine) return _fullMatch;
                
                const refText = inner.replace(/\*\*/g, '').replace(/\*/g, '');
                const engineInput = '⟪⟪' + refText + '⟫⟫';
                const parsed = this.safeParse(engineInput);
                if (!parsed) return inner;
                const clauses: Array<[string, number, number, string[][]]> = JSON.parse(parsed);
                if (clauses.length === 0) return inner;

                let result = inner;
                let bookName = '';
                const sorted = [...clauses].sort((a, b) => b[0].length - a[0].length);
                
                for (let i = 0; i < sorted.length; i++) {
                    const [clauseText, , , ranges] = sorted[i];
                    const origIndex = clauses.indexOf(sorted[i]);
                    
                    if (origIndex === 0) {
                        const match = clauseText.match(/^(.+?)\s+\d/);
                        if (match) bookName = match[1];
                    }
                    
                    let displayText = clauseText;
                    if (/^\d/.test(clauseText) && !/^\d+\s*[a-zA-Z]/.test(clauseText) && bookName && !clauseText.startsWith(bookName)) {
                        displayText = `${bookName} ${clauseText}`;
                    }
                    
                    for (const range of ranges) {
                        const bcv = range[0] === range[1] ? range[0] : `${range[0]}-${range[1]}`;
                        const link = `<a class="traverture-ref-link" data-bcv="${bcv}" data-ref="${displayText}">${clauseText}</a>`;
                        const escaped = clauseText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        
                        if (/^\d+$/.test(clauseText)) {
                            const regex = new RegExp(`(^|[\\s,;])${escaped}(?=[\\s,;]|$)`, 'g');
                            result = result.replace(regex, `$1${link}`);
                        } else {
                            result = result.replace(new RegExp(escaped), link);
                        }
                        break;
                    }
                }
                return result;
            });
        }

        // Auto-detect references in remaining text
        if (this.settings.autoDetect && this.engine) {
            const tempDiv = activeDocument.createElement('div');
            const parsedHtml = new DOMParser().parseFromString(html, 'text/html');
            for (const child of Array.from(parsedHtml.body.childNodes)) {
                tempDiv.appendChild(child.cloneNode(true));
            }
            const walker = activeDocument.createTreeWalker(tempDiv, NodeFilter.SHOW_TEXT, {
                acceptNode: (node) => {
                    const parent = node.parentElement;
                    if (parent?.tagName === 'A' && parent.classList.contains('traverture-ref-link')) {
                        return NodeFilter.FILTER_REJECT;
                    }
                    return NodeFilter.FILTER_ACCEPT;
                }
            });

            const textNodes: Text[] = [];
            let node = walker.nextNode();
            while (node) { textNodes.push(node as Text); node = walker.nextNode(); }

            for (const textNode of textNodes) {
                const text = textNode.nodeValue || '';
                const parsed = this.safeParse(text);
                if (!parsed) continue;
                const clauses: Array<[string, number, number, string[][]]> = JSON.parse(parsed);
                if (clauses.length === 0) continue;

                const linked = this.insertLinks(text, clauses);
                if (linked !== text) {
                    const fragment = activeDocument.createDocumentFragment();
                    const span = activeDocument.createElement('span');
                    const parsedLinked = new DOMParser().parseFromString(linked, 'text/html');
                    for (const child of Array.from(parsedLinked.body.childNodes)) {
                        fragment.appendChild(child.cloneNode(true));
                    }
                    while (span.firstChild) fragment.appendChild(span.firstChild);
                    textNode.parentNode?.replaceChild(fragment, textNode);
                }
            }
            html = tempDiv.innerHTML;
        }

        // Replace element content
        const parsed = new DOMParser().parseFromString(html, 'text/html');
        while (el.firstChild) el.removeChild(el.firstChild);
        for (const child of Array.from(parsed.body.childNodes)) {
            el.appendChild(child.cloneNode(true));
        }

        // Re-attach click handlers
        el.querySelectorAll('.traverture-ref-link').forEach(link => {
            link.addEventListener('click', (e) => { void (async () => {
                if ((e as MouseEvent).button !== 0) return;
                const bcv = link.getAttribute('data-bcv')!;
                if ((e as MouseEvent).ctrlKey || (e as MouseEvent).metaKey) {
                    const langSymbol = wasmModule.TravertureEngine.get_lang_symbol(this.settings.outputLanguage);
                    window.open(`jwlibrary:///finder?wtlocale=${langSymbol}&bible=${bcv}`, '_blank');
                    return;
                }
                e.preventDefault(); e.stopPropagation();

                // New: open directly based on user setting (skip popup)
                const scheme = this.settings.linkScheme ?? 'popup';
                if (scheme === 'jwlibrary' || scheme === 'jworg') {
                    const langSymbol = wasmModule.TravertureEngine.get_lang_symbol(this.settings.outputLanguage);
                    const timecodes = this.settings.outputLanguage === 'ase'
                        ? await getAslTimecodes(bcv)
                        : undefined;

                    const url = scheme === 'jwlibrary'
                        ? (timecodes
                            ? `jwlibrary:///finder?wtlocale=${langSymbol}&bible=${bcv}&ts=${timecodes}`
                            : `jwlibrary:///finder?wtlocale=${langSymbol}&bible=${bcv}`)
                        : (timecodes
                            ? `https://www.jw.org/finder?wtlocale=${langSymbol}&bible=${bcv}&ts=${timecodes}`
                            : `https://www.jw.org/finder?wtlocale=${langSymbol}&bible=${bcv}`);

                    // Try the same open method used by ctrl/cmd+click first (window.open), then fall back to Electron shell or navigation.
                    try {
                        const opened = window.open(url, '_blank', 'noopener');
                        if (opened === null) {
                            const maybeRequire = (window as any).require;
                            if (maybeRequire) {
                                const { shell } = maybeRequire('electron') as typeof import('electron');
                                try { await shell.openExternal(url); } catch { /* ignore */ }
                            } else {
                                // navigation fallback
                                try { window.location.href = url; } catch { /* ignore */ }
                                setTimeout(() => { try { window.open(url, '_blank', 'noopener'); } catch {} }, 500);
                            }
                        }
                    } catch (err) {
                        const maybeRequire = (window as any).require;
                        if (maybeRequire) {
                            const { shell } = maybeRequire('electron') as typeof import('electron');
                            try { await shell.openExternal(url); } catch { /* ignore */ }
                        } else {
                            try { window.location.href = url; } catch { /* ignore */ }
                        }
                    }

                    return;
                }

                const fmtEngine = new wasmModule.TravertureEngine(this.settings.sourceLanguage, this.settings.outputLanguage, this.settings.titleFormat, false);
                const decoded = JSON.parse(fmtEngine.decode_scriptures(JSON.stringify([[bcv, bcv]])));
                const refText = decoded[0] || link.textContent || '';
                const timecodes = this.settings.outputLanguage === 'ase' 
                    ? await getAslTimecodes(bcv) 
                    : undefined;
                const modal = new VerseModal();
                modal.show({ html: `<p><em>Loading...</em></p>`, citation: refText }, bcv, this.settings.outputLanguage, refText, timecodes);
                const verseData = await fetchVerseWithExtras(bcv, this.settings.outputLanguage, modal.getSignal());
                if (!modal.isVisible()) return;
                modal.show(verseData || { html: `<p><em>Verse lookup unavailable</em></p>`, citation: refText }, bcv, this.settings.outputLanguage, refText, timecodes);
            })(); });
        });
        this.processingElements.delete(el);
    }

    private insertLinks(text: string, clauses: Array<[string, number, number, string[][]]>): string {
        if (clauses.length === 0) return text;
        
        const positions: Array<{ start: number; end: number; displayText: string; bcv: string; clauseText: string }> = [];
        let bookName = '';
        
        for (let i = 0; i < clauses.length; i++) {
            const [clauseText, startPos, endPos, ranges] = clauses[i];
            
            if (i === 0 || !/^\d/.test(clauseText)) {
                const match = clauseText.match(/^(.+?)\s+\d/);
                if (match) bookName = match[1];
            }
            
            let displayText = clauseText;
            if (/^\d/.test(clauseText) && !/^\d+\s*[a-zA-Z]/.test(clauseText) && bookName && !clauseText.startsWith(bookName)) {
                displayText = `${bookName} ${clauseText}`;
            }
            
            if (ranges.length === 0) continue;
            const bcv = ranges[0][0] === ranges[0][1] ? ranges[0][0] : `${ranges[0][0]}-${ranges[0][1]}`;
            
            positions.push({ start: startPos, end: endPos, displayText, bcv, clauseText });
        }
        
        if (positions.length === 0) return text;
        positions.sort((a, b) => a.start - b.start);
        
        let result = '';
        let pos = 0;

        for (const p of positions) {
            if (p.start < pos) continue;
            result += text.substring(pos, p.start);
            const link = `<a class="traverture-ref-link" data-bcv="${p.bcv}" data-ref="${p.displayText}">${text.substring(p.start, p.end)}</a>`;
            result += link;
            pos = p.end;
        }
        result += text.substring(pos);
        return result;
    }

    async onload() {
        await this.loadSettings();

        try { await wasmModule.default({ module_or_path: wasmBinary }); this.createEngine(); }
        catch (e) { console.error('tra.VER:ture: WASM error:', e); }

        this.addSettingTab(new TravertureSettingTab(this.app, this));
        this.registerView(VIEW_TYPE_TRAVERTURE_SIDEBAR, (leaf) => new TravertureSidebarView(leaf, this));

        this.registerEditorExtension(createTravertureEditorPlugin(this));

        this.registerMarkdownPostProcessor((element, _context) => {
            this.processElement(element);
        });

        this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, _view) => {
            const selection = editor.getSelection();
            menu.addItem((item: any) => {
                item.setTitle('tra.VER:ture').setIcon('book-open');
                const submenu = item.setSubmenu();

                if (selection) {
                    submenu.addItem((subItem: any) => subItem.setTitle('Parse selection').setIcon('sidebar-right').onClick(async () => { await this.showSidebarWithResults(await this.parseReferenc[...]
