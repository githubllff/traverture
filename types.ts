export interface TravertureSettings {
    sourceLanguage: string;
    outputLanguage: string;
    autoDetect: boolean;
    titleFormat: string;
    // New settings
    linkScheme?: 'popup' | 'jwlibrary' | 'jworg';
    offlineEpubEnabled?: boolean;
}

export const DEFAULT_SETTINGS: TravertureSettings = {
    sourceLanguage: 'en',
    outputLanguage: 'en',
    autoDetect: true,
    titleFormat: 'full',
    linkScheme: 'popup',
    offlineEpubEnabled: true,
};

export interface LanguageInfo {
    code: string;
    vernacularName: string;
    englishName: string;
    suffix: string;
}

export interface VerseData {
    html: string;
    citation: string;
    footnotes?: Array<{ id: number; content: string; source: string }>;
    crossReferences?: Array<{ id: number; source: string; targets: Array<{ vs: string; standardCitation: string; abbreviatedCitation: string }> }>;
    commentaries?: Array<{ id: number; content: string; source: string }>;
}

export const VIEW_TYPE_TRAVERTURE_SIDEBAR = 'traverture-sidebar-view';

export interface SidebarRef {
    scripture: string;
    fullRef: string;
    standardRef: string;
    officialRef: string;
    startBcv: string;
    endBcv: string;
    startCh: number;
    endCh: number;
    startVerse: number;
    endVerse: number;
    bookNum: number;
}
