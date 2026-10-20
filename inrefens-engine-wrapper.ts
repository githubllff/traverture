// @ts-ignore
import * as wasmModuleUntyped from './inrefens-engine.js';
// @ts-ignore
import wasmBinary from './inrefens-engine_bg.wasm';
import { App } from 'obsidian';
import { Citation, InrefensSettings } from './inrefens-types';

const WASM_START = '/*WASM-START*/';
const WASM_END = '/*WASM-END*/';

const wasmModule = wasmModuleUntyped as any;

let engineInitialized = false;
let engineInstance: any = null;
let cachedLanguages: any = null;

export async function initInrefensEngine(app: App, language: string, travertureEnabled: boolean = true): Promise<void> {
    if (engineInitialized) return;

    const payload = (wasmBinary as any).slice
        ? (wasmBinary as any).slice((wasmBinary as any).indexOf(WASM_START) + WASM_START.length, (wasmBinary as any).indexOf(WASM_END))
        : null;

    let wasmBin: Uint8Array;
    if (payload) {
        wasmBin = Uint8Array.from(atob(payload), (c: string) => c.charCodeAt(0));
    } else {
        wasmBin = wasmBinary as any;
    }

    await wasmModule.default({ module_or_path: wasmBin });

    engineInstance = new wasmModule.InrefensEngine(language, travertureEnabled, 0);
    engineInitialized = true;
}

export function isInrefensEngineReady(): boolean {
    return engineInitialized && engineInstance !== null;
}

export function resetInrefensEngine(): void {
    engineInstance = null;
    engineInitialized = false;
    cachedLanguages = null;
}

export function findCitations(text: string): any[] | null {
    if (!engineInstance) return null;
    try {
        const json = engineInstance.find_citations(text);
        return JSON.parse(json);
    } catch (e) {
        console.error('inrefens: failed to parse citations:', e);
        return null;
    }
}

export function buildDelimitedUrl(text: string): string {
    if (!engineInstance) return '';
    try {
        return engineInstance.build_delimited_url(text);
    } catch {
        return '';
    }
}

export function getDelimitedQuery(text: string): string {
    if (!engineInstance) return '';
    try {
        return engineInstance.get_delimited_query(text);
    } catch {
        return '';
    }
}

export function buildWolUrl(query: string): string {
    if (!engineInstance) return '';
    try {
        return engineInstance.build_wol_url_for_query(query);
    } catch {
        return '';
    }
}