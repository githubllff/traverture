import { Plugin, WorkspaceLeaf, Notice, Menu, MarkdownView } from 'obsidian';
// @ts-ignore
import wasmBinary from './engine_bg.wasm';
// @ts-ignore
import * as wasmModule from './engine.js';
import { fetchVerseWithExtrasOfflineFirst, getAslTimecodes } from './cache';
import { createTravertureEditorPlugin } from './editor';
import { getAvailableLanguages } from './languages';
import { VerseModal } from './modal';
import { TravertureSettingTab } from './settings';
import { TravertureSidebarView } from './sidebar';
import { DEFAULT_SETTINGS, VIEW_TYPE_TRAVERTURE_SIDEBAR, SidebarRef } from './types';
import { VaultOfflineEpubRepository } from './VaultOfflineEpubRepository';
import { EpubImportService } from './EpubImportService';
import { augmentClauses, augmentClausesWithState } from './relativeRefs';
import { findWolTriggers, buildWolSearchUrl } from './wolSearch';

export default class TraverturePlugin extends Plugin {
    settings = DEFAULT_SETTINGS;
    engine: any = null;
    private processingElements = new Set<HTMLElement>();
    private lastRefBook = -1;
    private lastRefChapter = -1;

    // offline importer & repo
    offlineRepo: VaultOfflineEpubRepository | null = null;
    epubImportService: EpubImportService | null = null;

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    createEngine() {
        try {
            this.engine = new wasmModule.TravertureEngine(
                this.settings.sourceLanguage,
                this.settings.outputLanguage,
                'full',
                false
            );
        } catch (e) {
            console.error('tra.VER:ture: Failed to create engine:', e);
        }
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
        const engineText = text.replace(/\{\{(.+?)\}\}/g, '⟪⟪$1⟫⟫');
        const parsed = this.safeParse(engineText);
        if (!parsed) return results;

        let clauses: Array<[string, number, number, string[][]]> = JSON.parse(parsed);
        clauses = augmentClauses(engineText, clauses);
        if (clauses.length === 0) return results;

        let lastBookNum = -1;
        let groupStart = 0;
        let groupEnd = 0;
        let groupCount = 0;

        const clauseData: Array<{ ranges: string[][]; bookNum: number; original: string }> = [];

        for (const [, startPos, endPos, ranges] of clauses) {
            if (ranges.length === 0) continue;
            const bookNum = parseInt(ranges[0][0].substring(0, 2));

            if (bookNum !== lastBookNum) {
                if (lastBookNum !== -1 && groupCount > 0) {
                    const original = engineText.substring(groupStart, groupEnd);
                    for (let i = clauseData.length - 1; i >= 0 && i >= clauseData.length - groupCount; i--) {
                        clauseData[i].original = original;
                    }
                }
                groupStart = startPos;
                lastBookNum = bookNum;
                groupCount = 0;
            }
            groupEnd = endPos;
            groupCount++;
            clauseData.push({ ranges, bookNum, original: '' });
        }

        if (lastBookNum !== -1 && groupCount > 0) {
            const original = engineText.substring(groupStart, groupEnd);
            for (let i = clauseData.length - 1; i >= 0 && i >= clauseData.length - groupCount; i--) {
                clauseData[i].original = original;
            }
        }

        const engFull = new wasmModule.TravertureEngine('en', 'en', 'full', false);
        const engStd = new wasmModule.TravertureEngine('en', 'en', 'standard', false);
        const engOff = new wasmModule.TravertureEngine('en', 'en', 'official', false);

        for (const { ranges, bookNum, original } of clauseData) {
            for (const range of ranges) {
                const singleRange = [[range[0], range[1]]];
                const rangeJson = JSON.stringify(singleRange);
                const fullDecoded = JSON.parse(engFull.decode_scriptures(rangeJson));
                const stdDecoded = JSON.parse(engStd.decode_scriptures(rangeJson));
                const offDecoded = JSON.parse(engOff.decode_scriptures(rangeJson));
                const startBcv = range[0];
                const endBcv = range[1];

                results.push({
                    scripture: original,
                    fullRef: fullDecoded[0] || original,
                    standardRef: stdDecoded[0] || '',
                    officialRef: offDecoded[0] || '',
                    startBcv,
                    endBcv,
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
        const isMindMap = !!el.closest('.mindmap, .mm-mindmap-container, [class*="mindmap"]') ||
            !!el.querySelector('.mindmap, .mm-mindmap-container, [class*="mindmap"]');
        if (!isMindMap && el.querySelector('.callout, svg')) return;
        if (this.processingElements.has(el)) return;
        this.processingElements.add(el);

        let html = el.innerHTML;

        if (/\{\{(.+?)\}\}/g.test(html)) {
            html = html.replace(/\{\{(.+?)\}\}/g, (_fullMatch: string, inner: string) => {
                if (!this.engine) return _fullMatch;

                const refText = inner.replace(/\*\*/g, '').replace(/\*/g, '');
                const engineInput = '⟪⟪' + refText + '⟫⟫';
                const parsed = this.safeParse(engineInput);
                if (!parsed) return inner;

                let clauses: Array<[string, number, number, string[][]]> = JSON.parse(parsed);
                clauses = augmentClauses(engineInput, clauses);
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
                    if (
                        /^\d/.test(clauseText) &&
                        !/^\d+\s*[a-zA-Z]/.test(clauseText) &&
                        bookName &&
                        !clauseText.startsWith(bookName)
                    ) {
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

            const allTextNodes: Text[] = [];
            let node = walker.nextNode();
            while (node) {
                allTextNodes.push(node as Text);
                node = walker.nextNode();
            }

            let lastBook = this.lastRefBook;
            let lastChapter = this.lastRefChapter;

            for (const textNode of allTextNodes) {
                const text = textNode.nodeValue || '';
                if (!text) continue;

                const parsed = this.safeParse(text);
                let clauses: Array<[string, number, number, string[][]]> = [];
                if (parsed) {
                    try { clauses = JSON.parse(parsed); } catch { clauses = []; }
                }

                const isInsideAnchor = !!textNode.parentElement?.closest('a');

                if (isInsideAnchor) {
                    // Only update state from absolute refs; do not create links.
                    for (const c of clauses) {
                        const bcv = (c[3] && c[3][0] && c[3][0][0]) ? c[3][0][0] : '';
                        if (bcv) {
                            const b = parseInt(bcv.substring(0, 2), 10);
                            const ch = parseInt(bcv.substring(2, 5), 10);
                            if (b > 0) lastBook = b;
                            if (ch > 0) lastChapter = ch;
                        }
                    }
                    continue;
                }

                const { html: linked, lastBook: lb, lastChapter: lc } = this.insertLinks(text, clauses, lastBook, lastChapter);
                lastBook = lb;
                lastChapter = lc;

                if (linked !== text) {
                    const fragment = activeDocument.createDocumentFragment();
                    const parsedLinked = new DOMParser().parseFromString(linked, 'text/html');
                    for (const child of Array.from(parsedLinked.body.childNodes)) {
                        fragment.appendChild(child.cloneNode(true));
                    }
                    textNode.parentNode?.replaceChild(fragment, textNode);
                }
            }

            this.lastRefBook = lastBook;
            this.lastRefChapter = lastChapter;

            html = tempDiv.innerHTML;
        }

        if (this.settings.enableWolSearch !== false) {
            html = this.linkWolSearchesInHtml(html);
        }

        const parsed = new DOMParser().parseFromString(html, 'text/html');
        while (el.firstChild) el.removeChild(el.firstChild);
        for (const child of Array.from(parsed.body.childNodes)) {
            el.appendChild(child.cloneNode(true));
        }

        el.querySelectorAll('.traverture-ref-link').forEach(link => {
            link.addEventListener('click', (e) => {
                void (async () => {
                    if ((e as MouseEvent).button !== 0) return;
                    e.preventDefault();
                    e.stopPropagation();

                    const bcv = link.getAttribute('data-bcv')!;

                    const scheme = this.settings.linkScheme ?? 'popup';
                    if (scheme === 'jwlibrary' || scheme === 'jworg') {
                        const languages = getAvailableLanguages();
                        const langObj = languages.find(l => l.code === this.settings.outputLanguage);
                        const langSymbol = langObj
                            ? wasmModule.TravertureEngine.get_lang_symbol(this.settings.outputLanguage)
                            : 'E';
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

                        try {
                            const maybeRequire = (window as any).require;
                            if (maybeRequire) {
                                const { shell } = maybeRequire('electron') as any;
                                await shell.openExternal(url);
                            } else {
                                window.open(url, '_blank', 'noopener');
                            }
                        } catch {
                            window.open(url, '_blank', 'noopener');
                        }

                        return;
                    }

                    const fmtEngine = new wasmModule.TravertureEngine(
                        this.settings.sourceLanguage,
                        this.settings.outputLanguage,
                        this.settings.titleFormat,
                        false
                    );
                    const decoded = JSON.parse(fmtEngine.decode_scriptures(JSON.stringify([[bcv, bcv]])));
                    const refText = decoded[0] || link.textContent || '';
                    const timecodes = this.settings.outputLanguage === 'ase'
                        ? await getAslTimecodes(bcv)
                        : undefined;

                    const modal = new VerseModal();
                    modal.show(
                        { html: `<p><em>Loading...</em></p>`, citation: refText },
                        bcv,
                        this.settings.outputLanguage,
                        refText,
                        timecodes
                    );

                    const verseData = await fetchVerseWithExtrasOfflineFirst(
                        bcv,
                        this.settings.outputLanguage,
                        this.offlineRepo,
                        modal.getSignal()
                    );

                    if (!modal.isVisible()) return;

                    modal.show(
                        verseData || { html: `<p><em>Verse lookup unavailable</em></p>`, citation: refText },
                        bcv,
                        this.settings.outputLanguage,
                        refText,
                        timecodes
                    );
                })();
            });
        });

        void this.appendInlineVerseText(el);

        if (this.settings.enableWolSearch !== false) {
            this.applyWolSearchLinks(el);
            // Mindmap views may finish rendering asynchronously; re-apply.
            setTimeout(() => {
                if (this.settings.enableWolSearch !== false) this.applyWolSearchLinks(el);
            }, 50);
        }

        this.processingElements.delete(el);
    }

    private applyWolSearchLinks(el: HTMLElement): void {
        const walker = activeDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
            acceptNode: (node) => {
                const parent = node.parentElement;
                if (!parent) return NodeFilter.FILTER_REJECT;
                if (parent.tagName === 'A') return NodeFilter.FILTER_REJECT;
                if (parent.tagName === 'CODE' || parent.tagName === 'PRE') return NodeFilter.FILTER_REJECT;
                if (parent.closest('.traverture-wol-link')) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            },
        });

        const textNodes: Text[] = [];
        let node = walker.nextNode();
        while (node) {
            textNodes.push(node as Text);
            node = walker.nextNode();
        }

        for (const textNode of textNodes) {
            const text = textNode.nodeValue || '';
            if (!text) continue;
            const triggers = findWolTriggers(text);
            if (triggers.length === 0) continue;

            const sorted = [...triggers].sort((a, b) => a.start - b.start);
            const fragment = activeDocument.createDocumentFragment();
            let pos = 0;
            for (const t of sorted) {
                if (t.start > pos) {
                    fragment.appendChild(activeDocument.createTextNode(text.substring(pos, t.start)));
                }
                const anchor = activeDocument.createElement('a');
                anchor.className = 'traverture-wol-link';
                anchor.href = buildWolSearchUrl(this.settings, t.query, t.site, t.phrase);
                anchor.target = '_blank';
                anchor.rel = 'noopener noreferrer';
                anchor.textContent = text.substring(t.start, t.end);
                fragment.appendChild(anchor);
                pos = t.end;
            }
            if (pos < text.length) {
                fragment.appendChild(activeDocument.createTextNode(text.substring(pos)));
            }
            textNode.parentNode?.replaceChild(fragment, textNode);
        }
    }

    private linkWolSearchesInHtml(html: string): string {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
            acceptNode: (node) => {
                const parent = node.parentElement;
                if (!parent) return NodeFilter.FILTER_REJECT;
                if (parent.tagName === 'A' || parent.tagName === 'CODE' || parent.tagName === 'PRE') {
                    return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
            },
        });

        const textNodes: Text[] = [];
        let node = walker.nextNode();
        while (node) {
            textNodes.push(node as Text);
            node = walker.nextNode();
        }

        for (const textNode of textNodes) {
            const text = textNode.nodeValue || '';
            if (!text) continue;
            const triggers = findWolTriggers(text);
            if (triggers.length === 0) continue;

            const sorted = [...triggers].sort((a, b) => a.start - b.start);
            const fragment = doc.createDocumentFragment();
            let pos = 0;
            for (const t of sorted) {
                if (t.start > pos) {
                    fragment.appendChild(doc.createTextNode(text.substring(pos, t.start)));
                }
                const anchor = doc.createElement('a');
                anchor.className = 'traverture-wol-link';
                anchor.href = buildWolSearchUrl(this.settings, t.query, t.site, t.phrase);
                anchor.target = '_blank';
                anchor.rel = 'noopener noreferrer';
                anchor.textContent = text.substring(t.start, t.end);
                fragment.appendChild(anchor);
                pos = t.end;
            }
            if (pos < text.length) {
                fragment.appendChild(doc.createTextNode(text.substring(pos)));
            }
            textNode.parentNode?.replaceChild(fragment, textNode);
        }

        return doc.body.innerHTML;
    }

    private async appendInlineVerseText(el: HTMLElement): Promise<void> {
        if (!this.settings.showVerseText) return;

        const links = Array.from(el.querySelectorAll('.traverture-ref-link')) as HTMLElement[];
        for (const link of links) {
            if (link.dataset.inlineDone === '1') continue;
            link.dataset.inlineDone = '1';

            const bcv = link.getAttribute('data-bcv');
            if (!bcv) continue;

            // Skip whole-chapter / whole-book references (no verse specified).
            if (!link.textContent || !link.textContent.includes(':')) {
                continue;
            }

            void (async () => {
                const verseData = await fetchVerseWithExtrasOfflineFirst(
                    bcv,
                    this.settings.outputLanguage,
                    this.offlineRepo
                );
                if (!verseData) return;

                const tempDiv = activeDocument.createElement('div');
                const parsedHtml = new DOMParser().parseFromString(verseData.html, 'text/html');
                for (const child of Array.from(parsedHtml.body.childNodes)) {
                    tempDiv.appendChild(child.cloneNode(true));
                }
                const text = (tempDiv.textContent || '').replace(/\s+/g, ' ').trim();
                if (!text) return;

                const span = activeDocument.createElement('span');
                span.className = 'traverture-inline-verse';
                span.textContent = ` — ${text}`;
                link.insertAdjacentElement('afterend', span);
            })();
        }
    }

    private insertLinks(
        text: string,
        clauses: Array<[string, number, number, string[][]]>,
        initialBook: number = -1,
        initialChapter: number = -1
    ): { html: string; lastBook: number; lastChapter: number } {
        const augmented = augmentClausesWithState(text, clauses, initialBook, initialChapter);
        clauses = augmented.clauses;
        if (clauses.length === 0) {
            return { html: text, lastBook: augmented.lastBook, lastChapter: augmented.lastChapter };
        }

        const positions: Array<{
            start: number;
            end: number;
            displayText: string;
            bcv: string;
            clauseText: string;
        }> = [];

        let bookName = '';

        for (let i = 0; i < clauses.length; i++) {
            const [clauseText, startPos, endPos, ranges] = clauses[i];

            if (i === 0 || !/^\d/.test(clauseText)) {
                const match = clauseText.match(/^(.+?)\s+\d/);
                if (match) bookName = match[1];
            }

            let displayText = clauseText;
            if (
                /^\d/.test(clauseText) &&
                !/^\d+\s*[a-zA-Z]/.test(clauseText) &&
                bookName &&
                !clauseText.startsWith(bookName)
            ) {
                displayText = `${bookName} ${clauseText}`;
            }

            if (ranges.length === 0) continue;
            const bcv = ranges[0][0] === ranges[0][1] ? ranges[0][0] : `${ranges[0][0]}-${ranges[0][1]}`;

            positions.push({ start: startPos, end: endPos, displayText, bcv, clauseText });
        }

        if (positions.length === 0) return { html: text, lastBook: augmented.lastBook, lastChapter: augmented.lastChapter };
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
        return { html: result, lastBook: augmented.lastBook, lastChapter: augmented.lastChapter };
    }

    async onload() {
        await this.loadSettings();

        try {
            await wasmModule.default({ module_or_path: wasmBinary });
            this.createEngine();
        } catch (e) {
            console.error('tra.VER:ture: WASM error:', e);
        }

        this.offlineRepo = new VaultOfflineEpubRepository(this.app, this.manifest.id);
        this.epubImportService = new EpubImportService(this.offlineRepo);

        this.addSettingTab(new TravertureSettingTab(this.app, this));
        this.registerView(VIEW_TYPE_TRAVERTURE_SIDEBAR, (leaf) => new TravertureSidebarView(leaf, this));

        this.registerEditorExtension(createTravertureEditorPlugin(this));

        this.registerMarkdownPostProcessor((element, _context) => {
            this.processElement(element);
        });

        // Ensure wol: search links are applied even in views that render
        // asynchronously (e.g. mindmaps), where the post-processor may run
        // before the final DOM is in place.
        if (this.settings.enableWolSearch !== false) {
            const observer = new MutationObserver((mutations) => {
                if (this.settings.enableWolSearch === false) return;
                for (const m of mutations) {
                    for (const node of Array.from(m.addedNodes)) {
                        if (node instanceof HTMLElement && (node.textContent || '').includes('wol:')) {
                            this.applyWolSearchLinks(node);
                        }
                    }
                }
            });
            observer.observe(activeDocument.body, { childList: true, subtree: true });
            this.register(() => observer.disconnect());
        }

        this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, _view) => {
            const selection = editor.getSelection();

            menu.addItem((item: any) => {
                item.setTitle('tra.VER:ture').setIcon('book-open');
                const submenu = item.setSubmenu();

                if (selection) {
                    submenu.addItem((subItem: any) => {
                        subItem
                            .setTitle('Parse selection')
                            .setIcon('sidebar-right')
                            .onClick(async () => {
                                await this.showSidebarWithResults(
                                    await this.parseReferences(selection)
                                );
                            });
                    });

                    submenu.addItem((subItem: any) => {
                        subItem.setTitle('Insert citation').setIcon('quote-glyph');
                        const citeMenu = subItem.setSubmenu();

                        citeMenu.addItem((citeItem: any) => {
                            citeItem
                                .setTitle('Reference: "verse"')
                                .onClick(async () => {
                                    await this.insertCitation(editor, selection, false);
                                });
                        });

                        citeMenu.addItem((citeItem: any) => {
                            citeItem
                                .setTitle('"verse" (Reference)')
                                .onClick(async () => {
                                    await this.insertCitation(editor, selection, true);
                                });
                        });
                    });

                    submenu.addItem((subItem: any) => {
                        subItem.setTitle('Reformat selection').setIcon('pencil');
                        const reformatMenu = subItem.setSubmenu();

                        reformatMenu.addItem((fmtItem: any) => {
                            fmtItem
                                .setTitle('Full (1 Corinthians)')
                                .onClick(() => this.reformatReferences(editor, selection, 'full'));
                        });

                        reformatMenu.addItem((fmtItem: any) => {
                            fmtItem
                                .setTitle('Standard (1 Cor.)')
                                .onClick(() => this.reformatReferences(editor, selection, 'standard'));
                        });

                        reformatMenu.addItem((fmtItem: any) => {
                            fmtItem
                                .setTitle('Official (1Co)')
                                .onClick(() => this.reformatReferences(editor, selection, 'official'));
                        });
                    });

                    submenu.addSeparator();
                }

                submenu.addItem((subItem: any) => {
                    subItem
                        .setTitle('Parse document')
                        .setIcon('sidebar-right')
                        .onClick(async () => {
                            await this.showSidebarWithResults(
                                await this.parseReferences(editor.getValue())
                            );
                        });
                });

                submenu.addItem((subItem: any) => {
                    subItem.setTitle('Reformat document').setIcon('pencil');
                    const reformatMenu = subItem.setSubmenu();

                    reformatMenu.addItem((fmtItem: any) => {
                        fmtItem
                            .setTitle('Full (1 Corinthians)')
                            .onClick(() => this.reformatReferences(editor, editor.getValue(), 'full', true));
                    });

                    reformatMenu.addItem((fmtItem: any) => {
                        fmtItem
                            .setTitle('Standard (1 Cor.)')
                            .onClick(() => this.reformatReferences(editor, editor.getValue(), 'standard', true));
                    });

                    reformatMenu.addItem((fmtItem: any) => {
                        fmtItem
                            .setTitle('Official (1Co)')
                            .onClick(() => this.reformatReferences(editor, editor.getValue(), 'official', true));
                    });
                });

                submenu.addSeparator();

                submenu.addItem((subItem: any) => {
                    subItem.setTitle('Source language').setIcon('book-open');
                    const langMenu = subItem.setSubmenu();
                    const languages = getAvailableLanguages().filter(l => l.code !== 'ase');

                    for (const lang of languages) {
                        langMenu.addItem((langItem: any) => {
                            langItem
                                .setTitle(`${lang.vernacularName} (${lang.code})`)
                                .setChecked(lang.code === this.settings.sourceLanguage)
                                .onClick(async () => {
                                    this.settings.sourceLanguage = lang.code;
                                    await this.saveSettings();
                                    this.createEngine();
                                    new Notice(`Source language: ${lang.vernacularName}`);
                                });
                        });
                    }
                });

                submenu.addItem((subItem: any) => {
                    subItem.setTitle('Output language').setIcon('languages');
                    const langMenu = subItem.setSubmenu();
                    const languages = getAvailableLanguages();

                    for (const lang of languages) {
                        langMenu.addItem((langItem: any) => {
                            langItem
                                .setTitle(`${lang.vernacularName} (${lang.code})`)
                                .setChecked(lang.code === this.settings.outputLanguage)
                                .onClick(async () => {
                                    this.settings.outputLanguage = lang.code;
                                    await this.saveSettings();
                                    this.createEngine();
                                    new Notice(`Output language: ${lang.vernacularName}`);
                                });
                        });
                    }
                });
            });
        }));

        this.registerDomEvent(activeDocument, 'contextmenu', (evt: MouseEvent) => {
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (!view || view.getMode() !== 'preview') return;

            const selection = activeDocument.getSelection()?.toString() || '';

            evt.preventDefault();
            evt.stopPropagation();

            const menu = new Menu();
            menu.addItem((item: any) => {
                item.setTitle('tra.VER:ture').setIcon('book-open');
                const submenu = item.setSubmenu();

                if (selection) {
                    submenu.addItem((subItem: any) =>
                        subItem.setTitle('Parse selection').setIcon('sidebar-right').onClick(async () => {
                            await this.showSidebarWithResults(await this.parseReferences(selection));
                        })
                    );
                }

                submenu.addItem((subItem: any) =>
                    subItem.setTitle('Parse document').setIcon('sidebar-right').onClick(async () => {
                        const file = view.file;
                        if (!file) return;
                        const content = this.stripFrontmatter(await this.app.vault.read(file));
                        await this.showSidebarWithResults(await this.parseReferences(content));
                    })
                );

                submenu.addSeparator();

                submenu.addItem((subItem: any) => {
                    subItem.setTitle('Source language').setIcon('book-open');
                    const langMenu = subItem.setSubmenu();
                    const languages = getAvailableLanguages().filter(l => l.code !== 'ase');
                    for (const lang of languages) {
                        langMenu.addItem((langItem: any) =>
                            langItem
                                .setTitle(`${lang.vernacularName} (${lang.code})`)
                                .setChecked(lang.code === this.settings.sourceLanguage)
                                .onClick(async () => {
                                    this.settings.sourceLanguage = lang.code;
                                    await this.saveSettings();
                                    this.createEngine();
                                    new Notice(`Source language: ${lang.vernacularName}`);
                                })
                        );
                    }
                });

                submenu.addItem((subItem: any) => {
                    subItem.setTitle('Output language').setIcon('languages');
                    const langMenu = subItem.setSubmenu();
                    const languages = getAvailableLanguages();
                    for (const lang of languages) {
                        langMenu.addItem((langItem: any) =>
                            langItem
                                .setTitle(`${lang.vernacularName} (${lang.code})`)
                                .setChecked(lang.code === this.settings.outputLanguage)
                                .onClick(async () => {
                                    this.settings.outputLanguage = lang.code;
                                    await this.saveSettings();
                                    this.createEngine();
                                    new Notice(`Output language: ${lang.vernacularName}`);
                                })
                        );
                    }
                });
            });
            menu.showAtMouseEvent(evt);
        });

        this.addRibbonIcon('scroll', 'tra.VER:ture', () => {
            this.showTravertureMenu().showAtMouseEvent({ clientX: 100, clientY: 100 } as MouseEvent);
        });

        this.addCommand({
            id: 'open-menu',
            name: 'tra.VER:ture: Open menu',
            icon: 'scroll',
            editorCallback: () => {
                this.showTravertureMenu().showAtMouseEvent({ clientX: 100, clientY: 100 } as MouseEvent);
            }
        });

        this.addCommand({
            id: 'parse-document-references',
            name: 'tra.VER:ture: Parse document',
            icon: 'file-text',
            callback: async () => {
                const file = this.app.workspace.getActiveFile();
                if (!file) return;
                const content = this.stripFrontmatter(await this.app.vault.read(file));
                await this.showSidebarWithResults(await this.parseReferences(content));
            }
        });

        this.addCommand({
            id: 'parse-selection-references',
            name: 'tra.VER:ture: Parse selection',
            icon: 'sidebar-right',
            editorCallback: async (editor: any) => {
                const selection = editor.getSelection();
                if (!selection) return;
                await this.showSidebarWithResults(await this.parseReferences(selection));
            }
        });

        this.addCommand({
            id: 'insert-citation-ref',
            name: 'tra.VER:ture: Insert citation (Reference)',
            icon: 'quote-glyph',
            editorCallback: async (editor: any) => {
                const selection = editor.getSelection();
                if (!selection) return;
                await this.insertCitation(editor, selection, false);
            }
        });

        this.addCommand({
            id: 'insert-citation-verse',
            name: 'tra.VER:ture: Insert citation (verse)',
            icon: 'quote-glyph',
            editorCallback: async (editor: any) => {
                const selection = editor.getSelection();
                if (!selection) return;
                await this.insertCitation(editor, selection, true);
            }
        });

        this.addCommand({
            id: 'reformat-full',
            name: 'tra.VER:ture: Reformat (Full)',
            icon: 'pencil',
            editorCallback: (editor: any) => {
                const selection = editor.getSelection();
                if (!selection) return;
                this.reformatReferences(editor, selection, 'full');
            }
        });

        this.addCommand({
            id: 'reformat-standard',
            name: 'tra.VER:ture: Reformat (Standard)',
            icon: 'pencil',
            editorCallback: (editor: any) => {
                const selection = editor.getSelection();
                if (!selection) return;
                this.reformatReferences(editor, selection, 'standard');
            }
        });

        this.addCommand({
            id: 'reformat-official',
            name: 'tra.VER:ture: Reformat (Official)',
            icon: 'pencil',
            editorCallback: (editor: any) => {
                const selection = editor.getSelection();
                if (!selection) return;
                this.reformatReferences(editor, selection, 'official');
            }
        });
    }

    async showSidebarWithResults(refs: SidebarRef[]) {
        const { workspace } = this.app;
        let leaves = workspace.getLeavesOfType(VIEW_TYPE_TRAVERTURE_SIDEBAR);
        let leaf: WorkspaceLeaf;

        if (leaves.length > 0) {
            leaf = leaves[0];
        } else {
            const rightLeaf = workspace.getRightLeaf(false);
            if (!rightLeaf) return;
            await rightLeaf.setViewState({ type: VIEW_TYPE_TRAVERTURE_SIDEBAR, active: true });
            leaf = rightLeaf;
        }

        await leaf.loadIfDeferred();
        void workspace.revealLeaf(leaf);
        void (leaf.view as TravertureSidebarView).displayResults(refs);
    }

    reformatReferences(editor: any, text: string, format: string, wholeDoc: boolean = false) {
        const parsed = this.engine?.parse(
            this.settings.sourceLanguage,
            this.settings.outputLanguage,
            'full',
            false,
            text
        );
        if (!parsed) return;

        let clauses: Array<[string, number, number, string[][]]> = JSON.parse(parsed);
        clauses = augmentClauses(text, clauses);
        if (clauses.length === 0) return;

        const fmtEngine = new wasmModule.TravertureEngine(
            this.settings.sourceLanguage,
            this.settings.sourceLanguage,
            format,
            false
        );
        let processed = text;

        for (let i = clauses.length - 1; i >= 0; i--) {
            const [, startPos, endPos, ranges] = clauses[i];
            if (ranges.length === 0) continue;

            const decoded = JSON.parse(fmtEngine.decode_scriptures(JSON.stringify([ranges[0]])));
            const formattedRef = decoded[0] || '';
            if (!formattedRef) continue;

            const before = processed.substring(0, startPos);
            const after = processed.substring(endPos);
            processed = before + formattedRef + after;
        }

        if (wholeDoc) {
            editor.setValue(processed);
        } else {
            editor.replaceSelection(processed);
        }
    }

    async insertCitation(editor: any, text: string, withRef: boolean) {
        const parsed = this.engine?.parse(
            this.settings.sourceLanguage,
            this.settings.sourceLanguage,
            'full',
            false,
            text
        );
        if (!parsed) {
            new Notice('No scripture references found.');
            return;
        }

        let clauses: Array<[string, number, number, string[][]]> = JSON.parse(parsed);
        clauses = augmentClauses(text, clauses);
        if (clauses.length === 0) {
            new Notice('No scripture references found.');
            return;
        }

        const groups: Array<{ original: string; bcvs: string[] }> = [];
        let lastBookNum = -1;
        let groupStart = 0;
        let groupEnd = 0;
        let currentBcvs: string[] = [];

        for (const [, startPos, endPos, ranges] of clauses) {
            if (ranges.length === 0) continue;
            const bookNum = parseInt(ranges[0][0].substring(0, 2));

            if (bookNum !== lastBookNum) {
                if (currentBcvs.length > 0) {
                    groups.push({ original: text.substring(groupStart, groupEnd), bcvs: currentBcvs });
                }
                groupStart = startPos;
                lastBookNum = bookNum;
                currentBcvs = [];
            }

            groupEnd = endPos;

            for (const range of ranges) {
                currentBcvs.push(range[0] === range[1] ? range[0] : `${range[0]}-${range[1]}`);
            }
        }

        if (currentBcvs.length > 0) {
            groups.push({ original: text.substring(groupStart, groupEnd), bcvs: currentBcvs });
        }

        let result = text;
        const fetchedCache = new Map<string, string>();

        for (const group of groups) {
            let allText = '';

            for (const bcv of group.bcvs) {
                const cacheKey = `${this.settings.outputLanguage}:${bcv}`;
                let verseText = fetchedCache.get(cacheKey);

                if (verseText === undefined) {
                    const verseData = await fetchVerseWithExtrasOfflineFirst(bcv, this.settings.outputLanguage, this.offlineRepo);
                    if (verseData) {
                        let html = verseData.html
                            .replace(/<span class="parabreak"><\/span>/g, ' ')
                            .replace(/<span class="newblock"><\/span>/g, ' ');

                        const tempDiv = activeDocument.createElement('div');
                        const parsedHtml = new DOMParser().parseFromString(html, 'text/html');
                        for (const child of Array.from(parsedHtml.body.childNodes)) {
                            tempDiv.appendChild(child.cloneNode(true));
                        }

                        if (withRef) {
                            tempDiv.querySelectorAll('sup.verseNum, .chapterNum').forEach(el => el.remove());
                        } else {
                            tempDiv.querySelectorAll('.chapterNum').forEach(el => {
                                const textNode = el.querySelector('a') || el;
                                if (textNode) textNode.textContent = '1 ';
                            });
                        }

                        verseText = (tempDiv.textContent || '')
                            .replace(/\u00A0/g, ' ')
                            .replace(/\u202F/g, ' ')
                            .replace(/\+/g, '')
                            .replace(/\*/g, '')
                            .replace(/\s+/g, ' ')
                            .trim();

                        fetchedCache.set(cacheKey, verseText);
                    } else {
                        fetchedCache.set(cacheKey, '');
                    }
                }

                if (verseText) {
                    allText += (allText ? ' ' : '') + verseText;
                }
            }

            if (allText) {
                const escaped = group.original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                result = result.replace(
                    new RegExp(escaped),
                    withRef ? `"${allText}" (${group.original})` : `${group.original}: "${allText}"`
                );
            }
        }

        editor.replaceSelection(result);
    }

    showTravertureMenu() {
        const file = this.app.workspace.getActiveFile();
        const editor = this.app.workspace.activeEditor?.editor;
        const sel = editor?.getSelection();
        const menu = new Menu();

        if (sel) {
            menu.addItem((item: any) =>
                item.setTitle('Parse selection').setIcon('sidebar-right').onClick(async () => {
                    await this.showSidebarWithResults(await this.parseReferences(sel));
                })
            );

            menu.addItem((item: any) => {
                item.setTitle('Insert citation').setIcon('quote-glyph');
                const citeMenu = item.setSubmenu();

                citeMenu.addItem((citeItem: any) =>
                    citeItem.setTitle('Reference: "verse"').onClick(async () => {
                        if (editor && sel) await this.insertCitation(editor, sel, false);
                    })
                );

                citeMenu.addItem((citeItem: any) =>
                    citeItem.setTitle('"verse" (Reference)').onClick(async () => {
                        if (editor && sel) await this.insertCitation(editor, sel, true);
                    })
                );
            });

            menu.addItem((item: any) => {
                item.setTitle('Reformat selection').setIcon('pencil');
                const submenu = item.setSubmenu();

                submenu.addItem((fmtItem: any) =>
                    fmtItem.setTitle('Full (1 Corinthians)').onClick(() => this.reformatReferences(editor!, sel, 'full'))
                );
                submenu.addItem((fmtItem: any) =>
                    fmtItem.setTitle('Standard (1 Cor.)').onClick(() => this.reformatReferences(editor!, sel, 'standard'))
                );
                submenu.addItem((fmtItem: any) =>
                    fmtItem.setTitle('Official (1Co)').onClick(() => this.reformatReferences(editor!, sel, 'official'))
                );
            });

            menu.addSeparator();
        }

        menu.addItem((item: any) =>
            item.setTitle('Parse document').setIcon('sidebar-right').onClick(async () => {
                if (!file) {
                    new Notice('No file open.');
                    return;
                }
                const content = this.stripFrontmatter(await this.app.vault.read(file));
                await this.showSidebarWithResults(await this.parseReferences(content));
            })
        );

        menu.addItem((item: any) => {
            item.setTitle('Reformat document').setIcon('pencil');
            const submenu = item.setSubmenu();

            submenu.addItem((fmtItem: any) =>
                fmtItem.setTitle('Full (1 Corinthians)').onClick(() => {
                    if (editor) this.reformatReferences(editor, editor.getValue(), 'full', true);
                })
            );
            submenu.addItem((fmtItem: any) =>
                fmtItem.setTitle('Standard (1 Cor.)').onClick(() => {
                    if (editor) this.reformatReferences(editor, editor.getValue(), 'standard', true);
                })
            );
            submenu.addItem((fmtItem: any) =>
                fmtItem.setTitle('Official (1Co)').onClick(() => {
                    if (editor) this.reformatReferences(editor, editor.getValue(), 'official', true);
                })
            );
        });

        menu.addSeparator();

        menu.addItem((item: any) => {
            item.setTitle('Source language').setIcon('book-open');
            const langMenu = item.setSubmenu();
            const languages = getAvailableLanguages().filter(l => l.code !== 'ase');

            for (const lang of languages) {
                langMenu.addItem((langItem: any) =>
                    langItem
                        .setTitle(`${lang.vernacularName} (${lang.code})`)
                        .setChecked(lang.code === this.settings.sourceLanguage)
                        .onClick(async () => {
                            this.settings.sourceLanguage = lang.code;
                            await this.saveSettings();
                            this.createEngine();
                            new Notice(`Source language: ${lang.vernacularName}`);
                        })
                );
            }
        });

        menu.addItem((item: any) => {
            item.setTitle('Output language').setIcon('languages');
            const langMenu = item.setSubmenu();
            const languages = getAvailableLanguages();

            for (const lang of languages) {
                langMenu.addItem((langItem: any) =>
                    langItem
                        .setTitle(`${lang.vernacularName} (${lang.code})`)
                        .setChecked(lang.code === this.settings.outputLanguage)
                        .onClick(async () => {
                            this.settings.outputLanguage = lang.code;
                            await this.saveSettings();
                            this.createEngine();
                            new Notice(`Output language: ${lang.vernacularName}`);
                        })
                );
            }
        });

        return menu;
    }

    onunload() { }
}
