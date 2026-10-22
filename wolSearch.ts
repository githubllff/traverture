// wolSearch.ts
// Detects "wol.jw.org:" / "wol:" / "jw.org:" / "jw:" search triggers in text
// and builds search URLs for wol.jw.org / jw.org.

export interface WolTrigger {
    start: number;
    end: number;
    query: string;
    site: "wol" | "jw";
    phrase: boolean;
}

export interface WolSearchSettings {
    enableWolSearch?: boolean;
    wolSearchSite?: "wol" | "jw";
    outputLanguage?: string;
}

const TRIGGER_RE = /\b(wol\.jw\.org|jw\.org|wol|jw):/gi;

export function findWolTriggers(text: string): WolTrigger[] {
    const triggers: WolTrigger[] = [];
    let m: RegExpExecArray | null;
    while ((m = TRIGGER_RE.exec(text)) !== null) {
        const prefix = m[1].toLowerCase();
        const site: "wol" | "jw" = prefix.startsWith("jw") ? "jw" : "wol";
        // jw.org searches are quoted (exact phrase); wol searches are sentence searches.
        const phrase = site === "jw";

        const start = m.index;
        let i = m.index + m[0].length;
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
                if (end > i && ".!?".includes(text[end]) && (end + 1 >= text.length || /\s/.test(text[end + 1]))) break;
                if (end > i && /\s/.test(text[end - 1]) && /^(wol\.jw\.org|jw\.org|wol|jw):/i.test(text.slice(end))) {
                    break;
                }
                end++;
            }
            consumedEnd = end;
            query = text.substring(i, end).trim();
            query = query.replace(/[.!?;:,]+$/, "").trim();
        }

        if (query.length > 0) {
            triggers.push({ start, end: consumedEnd, query, site, phrase });
        }

        TRIGGER_RE.lastIndex = Math.max(TRIGGER_RE.lastIndex, consumedEnd);
    }
    return triggers;
}

export function buildWolSearchUrl(
    settings: WolSearchSettings | any,
    query: string,
    site?: "wol" | "jw",
    phrase?: boolean,
): string {
    const resolvedSite = site || (settings && settings.wolSearchSite) || "wol";
    const lang = (settings && settings.outputLanguage) || "en";
    const trimmed = query.trim();

    const shouldQuote = phrase !== undefined ? phrase : resolvedSite === "jw";
    const toEncode = shouldQuote
        ? (trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed : `\"${trimmed}\"`)
        : trimmed;
    const q = encodeURIComponent(toEncode).replace(/%20/g, "+");

    if (resolvedSite === "jw") {
        return `https://www.jw.org/en/search/?q=${q}`;
    }
    if (shouldQuote) {
        return `https://wol.jw.org/${encodeURIComponent(lang)}/wol/s/r1/lp-e?q=${q}`;
    }
    return `https://wol.jw.org/${encodeURIComponent(lang)}/wol/s/r1/lp-e?q=${q}&st=&p=sen&r=occ`;
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
