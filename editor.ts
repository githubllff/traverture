import { ItemView, WorkspaceLeaf } from 'obsidian';
// @ts-ignore
import * as wasmModule from './engine.js';
import { fetchVerseWithExtras, getAslTimecodes } from './cache';
import { getAvailableLanguages } from './languages';
import { VerseModal } from './modal';
import { SidebarRef, VIEW_TYPE_TRAVERTURE_SIDEBAR } from './types';
import type TraverturePlugin from './main';

export const SIDEBAR_COLUMNS = [
    { key: 'scripture', label: 'Original', width: '140px', align: 'left' as const },
    { key: 'fullRef', label: 'Full', width: '180px', align: 'left' as const },
    { key: 'standardRef', label: 'Standard', width: '140px', align: 'left' as const },
    { key: 'officialRef', label: 'Official', width: '120px', align: 'left' as const },
    { key: 'startBcv', label: 'Start BCV', width: '120px', align: 'center' as const, mono: true },
    { key: 'endBcv', label: 'End BCV', width: '120px', align: 'center' as const, mono: true },
    { key: 'startCh', label: 'Start Ch', width: '80px', align: 'center' as const, mono: true },
    { key: 'endCh', label: 'End Ch', width: '80px', align: 'center' as const, mono: true },
    { key: 'startVerse', label: 'Start Vs', width: '80px', align: 'center' as const, mono: true },
    { key: 'endVerse', label: 'End Vs', width: '80px', align: 'center' as const, mono: true },
];

export class TravertureSidebarView extends ItemView {
    plugin: TraverturePlugin;
    private allRefs: SidebarRef[] = [];
    private searchQuery = '';
    private sortColumn: string | null = null;
    private sortDir = 0;
    private visibleColumns = new Set(SIDEBAR_COLUMNS.map(c => c.key));
    private searchInputEl: HTMLInputElement | null = null;
    private outputLang: string;
    private capitalize = false;
    private uniqueOnly = false;

    constructor(leaf: WorkspaceLeaf, plugin: TraverturePlugin) {
        super(leaf);
        this.plugin = plugin;
        this.outputLang = plugin.settings.outputLanguage;
    }

    getViewType(): string { return VIEW_TYPE_TRAVERTURE_SIDEBAR; }
    getDisplayText(): string { return 'tra.VER:ture References'; }
    getIcon(): string { return 'book-open'; }

    async onOpen(): Promise<void> {
        this.contentEl.empty();
        this.contentEl.addClass('traverture-sidebar');
    }

    async onClose(): Promise<void> { this.contentEl.empty(); }

    async setState(state: any, result: any): Promise<void> {
        if (state) {
            if (state.outputLang !== undefined) this.outputLang = state.outputLang;
            if (state.capitalize !== undefined) this.capitalize = state.capitalize;
            if (state.uniqueOnly !== undefined) this.uniqueOnly = state.uniqueOnly;
            if (Array.isArray(state.visibleColumns)) this.visibleColumns = new Set(state.visibleColumns);
        }
        await super.setState(state, result);
    }

    getState(): any {
        return {
            ...super.getState(),
            outputLang: this.outputLang,
            capitalize: this.capitalize,
            uniqueOnly: this.uniqueOnly,
            visibleColumns: [...this.visibleColumns],
        };
    }

    private renderEmpty(message: string): void {
        this.contentEl.empty();
        this.contentEl.addClass('traverture-sidebar');
        this.contentEl.createEl('p', { text: message, cls: 'traverture-sidebar-empty' });
    }

    async displayResults(refs: SidebarRef[]): Promise<void> {
        this.allRefs = refs;
        this.sortColumn = null;
        this.sortDir = 0;
        this.render();
    }

    private normalizeForSearch(text: string): string {
        return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '').toLowerCase();
    }

    private getDisplayRef(ref: SidebarRef, format: 'full' | 'standard' | 'official'): string {
        const bookName = wasmModule.TravertureEngine.get_book_name(ref.bookNum, this.outputLang, format, this.capitalize);
        if (!bookName) return ref.fullRef;
        const englishName = wasmModule.TravertureEngine.get_book_name(ref.bookNum, 'en', 'full', false);
        if (englishName && ref.fullRef.startsWith(englishName)) {
            return `${bookName}${ref.fullRef.substring(englishName.length)}`;
        }
        return bookName;
    }

    private getFilteredSortedRefs(): SidebarRef[] {
        let refs = [...this.allRefs];
        if (this.uniqueOnly) {
            const seen = new Set<string>();
            refs = refs.filter(ref => {
                const key = this.getDisplayRef(ref, 'full');
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
        }
        if (this.searchQuery) {
            const query = this.normalizeForSearch(this.searchQuery);
            refs = refs.filter(ref => SIDEBAR_COLUMNS.some(column => {
                if (!this.visibleColumns.has(column.key)) return false;
                let value: string;
                if (column.key === 'fullRef') value = this.getDisplayRef(ref, 'full');
                else if (column.key === 'standardRef') value = this.getDisplayRef(ref, 'standard');
                else if (column.key === 'officialRef') value = this.getDisplayRef(ref, 'official');
                else value = String((ref as any)[column.key] ?? '');
                return this.normalizeForSearch(value).includes(query);
            }));
        }
        if (this.sortColumn && this.sortDir !== 0) {
            refs.sort((a, b) => {
                const value = (ref: SidebarRef): string | number => {
                    const key = this.sortColumn!;
                    if (key === 'fullRef') return this.getDisplayRef(ref, 'full');
                    if (key === 'standardRef') return this.getDisplayRef(ref, 'standard');
                    if (key === 'officialRef') return this.getDisplayRef(ref, 'official');
                    const raw = (ref as any)[key];
                    return typeof raw === 'number' ? raw : String(raw ?? '');
                };
                const av = value(a), bv = value(b);
                const comparison = typeof av === 'number' && typeof bv === 'number'
                    ? av - bv
                    : String(av).localeCompare(String(bv));
                return this.sortDir === 1 ? comparison : -comparison;
            });
        }
        return refs;
    }

    render(): void {
        const wasFocused = this.searchInputEl && activeDocument.activeElement === this.searchInputEl;
        this.contentEl.empty();
        this.contentEl.addClass('traverture-sidebar');
        if (this.allRefs.length === 0) {
            this.renderEmpty('No references found.');
            return;
        }

        const refs = this.getFilteredSortedRefs();
        const visibleColumns = SIDEBAR_COLUMNS.filter(column => this.visibleColumns.has(column.key));
        this.app.workspace.requestSaveLayout();
        const languages = getAvailableLanguages();
        const toolbar = this.contentEl.createDiv({ cls: 'traverture-sidebar-toolbar' });
        const topRow = toolbar.createDiv({ cls: 'traverture-sidebar-top-row' });
        const searchWrap = topRow.createDiv({ cls: 'traverture-sidebar-search-wrap' });
        this.searchInputEl = searchWrap.createEl('input', { type: 'text', placeholder: 'Search...', cls: 'traverture-sidebar-search' });
        this.searchInputEl.value = this.searchQuery;
        this.searchInputEl.addEventListener('input', () => {
            this.searchQuery = this.searchInputEl!.value;
            this.render();
        });
        if (this.searchQuery) {
            const clear = searchWrap.createEl('button', { cls: 'traverture-sidebar-search-clear' });
            clear.setText('\u2715');
            clear.addEventListener('click', () => { this.searchQuery = ''; this.render(); });
        }
        topRow.createEl('span', { text: `${refs.length} results`, cls: 'traverture-sidebar-count' });
        topRow.createDiv({ cls: 'traverture-sidebar-spacer' });
        const langSelect = topRow.createEl('select', { cls: 'traverture-sidebar-lang-select' });
        for (const language of languages) {
            const option = langSelect.createEl('option', { text: `${language.vernacularName} (${language.code})` });
            option.value = language.code;
            option.selected = language.code === this.outputLang;
        }
        langSelect.addEventListener('change', () => {
            this.outputLang = langSelect.value;
            this.plugin.settings.outputLanguage = langSelect.value;
            void this.plugin.saveSettings();
            this.plugin.createEngine();
            this.render();
        });
        const capsLabel = topRow.createEl('label', { cls: 'traverture-sidebar-caps-label' });
        const caps = capsLabel.createEl('input', { type: 'checkbox' });
        caps.checked = this.capitalize;
        caps.addEventListener('change', () => { this.capitalize = caps.checked; this.render(); });
        capsLabel.createEl('span', { text: 'CAPS' });
        const uniqueLabel = topRow.createEl('label', { cls: 'traverture-sidebar-caps-label' });
        const unique = uniqueLabel.createEl('input', { type: 'checkbox' });
        unique.checked = this.uniqueOnly;
        unique.addEventListener('change', () => { this.uniqueOnly = unique.checked; this.render(); });
        uniqueLabel.createEl('span', { text: 'UNIQUE' });
        const copy = topRow.createEl('button', { text: 'COPY', cls: 'traverture-sidebar-copy-btn' });
        copy.addEventListener('click', () => {
            const headers = visibleColumns.map(column => column.label).join('\t');
            const body = refs.map(ref => visibleColumns.map(column => {
                if (column.key === 'fullRef') return this.getDisplayRef(ref, 'full');
                if (column.key === 'standardRef') return this.getDisplayRef(ref, 'standard');
                if (column.key === 'officialRef') return this.getDisplayRef(ref, 'official');
                return String((ref as any)[column.key] ?? '');
            }).join('\t')).join('\n');
            void navigator.clipboard.writeText(`${headers}\n${body}`);
            copy.textContent = 'COPIED';
            window.setTimeout(() => { copy.textContent = 'COPY'; }, 1500);
        });
        const columnRow = toolbar.createDiv({ cls: 'traverture-sidebar-col-row' });
        columnRow.createEl('span', { text: 'Columns:', cls: 'traverture-sidebar-col-label' });
        const all = columnRow.createEl('button', { text: 'ALL', cls: 'traverture-sidebar-col-btn' });
        all.addEventListener('click', () => { this.visibleColumns = new Set(SIDEBAR_COLUMNS.map(column => column.key)); this.render(); });
        const refsButton = columnRow.createEl('button', { text: 'REFS', cls: 'traverture-sidebar-col-btn' });
        refsButton.addEventListener('click', () => { this.visibleColumns = new Set(['scripture', 'fullRef', 'standardRef', 'officialRef']); this.render(); });
        for (const column of SIDEBAR_COLUMNS) {
            const label = columnRow.createEl('label', { cls: 'traverture-sidebar-col-toggle' });
            const checkbox = label.createEl('input', { type: 'checkbox' });
            checkbox.checked = this.visibleColumns.has(column.key);
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) this.visibleColumns.add(column.key);
                else {
                    const remaining = [...this.visibleColumns].filter(key => key !== column.key);
                    if (remaining.length === 0) { checkbox.checked = true; return; }
                    this.visibleColumns.delete(column.key);
                }
                this.render();
            });
            label.createEl('span', { text: column.label });
        }
        const tableWrapper = this.contentEl.createDiv({ cls: 'traverture-sidebar-table-wrapper' });
        const table = tableWrapper.createEl('table', { cls: 'traverture-sidebar-table' });
        const header = table.createEl('thead').createEl('tr');
        for (const column of visibleColumns) {
            const th = header.createEl('th', { cls: 'traverture-sidebar-th' });
            th.style.width = column.width;
            th.style.minWidth = column.width;
            th.style.textAlign = column.align;
            const arrow = this.sortColumn === column.key
                ? (this.sortDir === 1 ? ' ▲' : this.sortDir === -1 ? ' ▼' : '')
                : '';
            th.textContent = column.key === 'scripture'
                ? `${column.label} (${this.plugin.settings.sourceLanguage})${arrow}`
                : column.label + arrow;
            th.addEventListener('click', () => {
                if (this.sortColumn === column.key) {
                    if (this.sortDir === 1) this.sortDir = -1;
                    else if (this.sortDir === -1) { this.sortDir = 0; this.sortColumn = null; }
                    else this.sortDir = 1;
                } else { this.sortColumn = column.key; this.sortDir = 1; }
                this.render();
            });
        }
        const body = table.createEl('tbody');
        for (const ref of refs) {
            const row = body.createEl('tr');
            for (const column of visibleColumns) {
                const td = row.createEl('td', { cls: 'traverture-sidebar-td' });
                td.style.textAlign = column.align;
                if (column.mono) td.addClass('traverture-mono');
                let displayValue: string;
                if (column.key === 'fullRef') displayValue = this.getDisplayRef(ref, 'full');
                else if (column.key === 'standardRef') displayValue = this.getDisplayRef(ref, 'standard');
                else if (column.key === 'officialRef') displayValue = this.getDisplayRef(ref, 'official');
                else displayValue = String((ref as any)[column.key] ?? '');
                if (column.key === 'fullRef' || column.key === 'standardRef' || column.key === 'officialRef') {
                    const link = td.createEl('a', { text: displayValue, cls: 'traverture-ref-link' });
                    const bcv = ref.startBcv === ref.endBcv ? ref.startBcv : `${ref.startBcv}-${ref.endBcv}`;
                    link.setAttribute('data-bcv', bcv);
                    link.setAttribute('data-ref', displayValue);
                    link.addEventListener('click', (event) => { void (async () => {
                        if (event.button !== 0) return;
                        const scheme = this.plugin.settings.linkScheme ?? 'popup';
                        if (scheme === 'jwlibrary') {
                            const langSymbol = wasmModule.TravertureEngine.get_lang_symbol(this.outputLang);
                            const timecodes = this.outputLang === 'ase' ? await getAslTimecodes(bcv) : undefined;
                            const url = timecodes
                                ? `jwlibrary:///finder?wtlocale=${langSymbol}&bible=${bcv}&ts=${timecodes}`
                                : `jwlibrary:///finder?wtlocale=${langSymbol}&bible=${bcv}`;
                            event.preventDefault();
                            event.stopPropagation();
                            window.open(url, '_blank');
                            return;
                        }
                        if (event.ctrlKey || event.metaKey) {
                            const langSymbol = wasmModule.TravertureEngine.get_lang_symbol(this.outputLang);
                            window.open(`jwlibrary:///finder?wtlocale=${langSymbol}&bible=${bcv}`, '_blank');
                            return;
                        }
                        event.preventDefault();
                        event.stopPropagation();
                        const timecodes = this.outputLang === 'ase' ? await getAslTimecodes(bcv) : undefined;
                        const modal = new VerseModal();
                        modal.show({ html: `<p><em>Loading...</em></p>`, citation: displayValue }, bcv, this.outputLang, displayValue, timecodes);
                        const verseData = await fetchVerseWithExtras(bcv, this.outputLang, modal.getSignal());
                        if (!modal.isVisible()) return;
                        modal.show(verseData || { html: `<p><em>Verse lookup unavailable</em></p>`, citation: displayValue }, bcv, this.outputLang, displayValue, timecodes);
                    })(); });
                } else {
                    td.setText(displayValue);
                }
            }
        }
        if (wasFocused && this.searchInputEl) {
            this.searchInputEl.focus();
            const length = this.searchInputEl.value.length;
            this.searchInputEl.setSelectionRange(length, length);
        }
    }
}
