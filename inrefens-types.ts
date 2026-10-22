// types.ts

// ──────────────────────────────────────────────
// Engine (WASM) types
// ──────────────────────────────────────────────

export interface InrefensEngineInstance {
    find_citations(text: string): string;
    get_language_info(): string;
    get_language_code(): string;
    build_delimited_url(text: string): string;
    get_delimited_query(text: string): string;
    build_wol_url_for_query(query: string): string;
}

export interface InrefensEngineStatic {
    new(languageCode: string, travertureEnabled: boolean, engineId: number): InrefensEngineInstance;
    get_available_languages(): string;
    get_version(): string;
    default(options: { module_or_path: unknown }): Promise<void>;
}

export interface InrefensEngineModule {
    InrefensEngine: InrefensEngineStatic;
    default(options: { module_or_path: unknown }): Promise<void>;
}

// ──────────────────────────────────────────────
// Engine output types
// ──────────────────────────────────────────────

export interface Citation {
    text: string;
    start: number;
    end: number;
    family: string;
    root: string;
    parts: CitationParts;
    wol_url: string;
}

export interface CitationParts {
    root: string;
    query: string;
    year?: number;
    month?: number;
    day?: number | null;
    page?: number | null;
    end_page?: number | null;
    paragraph?: number | null;
    end_paragraph?: number | null;
    volume?: number | null;
    title?: string | null;
}

// ──────────────────────────────────────────────
// Language types
// ──────────────────────────────────────────────

export interface LanguageInfo {
    language_id: number;
    language_code: string;
    language_symbol: string;
    language_name: string;
    english_name: string;
    link_suffix: string;
}

// ──────────────────────────────────────────────
// Plugin settings
// ──────────────────────────────────────────────

export interface InrefensSettings {
    language: string;
    linkColor: string;
    autoLink: boolean;
}

export const DEFAULT_SETTINGS: InrefensSettings = {
    language: 'en',
    linkColor: '',
    autoLink: true,
};