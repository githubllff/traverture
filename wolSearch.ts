// wolSearch.ts
// Detects "wol:" search triggers in text and builds search URLs for
// wol.jw.org / jw.org, mirroring the inrefens-style auto-linking.

export interface WolTrigger {
    start: number;
    end: number;
    query: string;
}

export interface WolSearchSettings {
    enableWolSearch?: boolean;
    wolSearchSite?: "wol" | "jw";
    outputLanguage?: string;
}

export function findWolTriggers(text: string): WolTrigger[] {
    const triggers: WolTrigger[] = [];
    const re = /\bwol:/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const start = m.index;
        let i = m.index + m[0].length;
        // Allow an optional space after the colon (e.g. "wol: search ...").
        if (text[i] === " ") i++;

        let query = "";
        let consumedEnd = i;

        if (text[i] === '"' || text[i] === "'") {
            const quote = text[i];
            i++;
            const closeIdx = text.indexOf(quote, i);
            const end = closeIdx === -1 ? text.length : closeIdx;
            query = text.substring(i, end);
            consumedEnd = closeIdx === -1 ? text.length : closeIdx + 1;
        } else {
            let end = i;
            while (end < text.length) {
                if (text[end] === "\n") break;
                if (text.startsWith("  ", end)) break;
                // Stop at a sentence terminator followed by space/end.
                if (end > i && ".!?".includes(text[end]) && (end + 1 >= text.length || /\s/.test(text[end + 1]))) break;
                // Stop when another trigger begins.
                if (end > i && /\s/.test(text[end - 1]) && text.slice(end).toLowerCase().startsWith("wol:")) break;
                end++;
            }
            consumedEnd = end;
            query = text.substring(i, end).trim();
            // Trim trailing punctuation that is unlikely to be part of the query.
            query = query.replace(/[.!?;:,]+$/, "").trim();
        }

        if (query.length > 0) {
            triggers.push({ start, end: consumedEnd, query });
        }

        re.lastIndex = Math.max(re.lastIndex, consumedEnd);
    }
    return triggers;
}

export function buildWolSearchUrl(settings: WolSearchSettings | any, query: string): string {
    const site = (settings && settings.wolSearchSite) || "wol";
    const lang = (settings && settings.outputLanguage) || "en";
    const q = encodeURIComponent(query.trim());

    if (site === "jw") {
        return `https://www.jw.org/en/search/?q=${q}`;
    }
    return `https://wol.jw.org/${encodeURIComponent(lang)}/wol/s/r1/lp-e?q=${q}`;
}

export function openExternalUrl(url: string): void {
    try {
        const maybeRequire = (window as any).require;
        if (maybeRequire) {
            const { shell } = maybeRequire("electron") as any;
            void shell.openExternal(url);
            return;
        }
    } catch {
        // fall through
    }
    window.open(url, "_blank", "noopener");
}
