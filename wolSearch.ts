// wolSearch.ts
// Detects search triggers in text and builds search URLs.

export interface WolTrigger {
    start: number;
    end: number;
    query: string;
    site: "wol" | "jw" | "perplexity" | "chat";
    phrase: boolean;
}

export interface WolSearchSettings {
    enableWolSearch?: boolean;
    wolSearchSite?: "wol" | "jw";
    outputLanguage?: string;
}

const TRIGGER_RE = /\b(perplexity|chat|wol\.jw\.org|jw\.org|wol|jw):/gi;

function restrictedQuery(query: string): string {
    return `${query.trim()} (search only on jw.org and wol.jw.org)`;
}

export function findWolTriggers(text: string): WolTrigger[] {
    const triggers: WolTrigger[] = [];
    let m: RegExpExecArray | null;
    while ((m = TRIGGER_RE.exec(text)) !== null) {
        const prefix = m[1].toLowerCase();
        let site: "wol" | "jw" | "perplexity" | "chat";
        let phrase = false;
        if (prefix === "perplexity") {
            site = "perplexity";
        } else if (prefix === "chat") {
            site = "chat";
        } else if (prefix.startsWith("jw")) {
            site = "jw";
        } else {
            site = "wol";
        }

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
                if (end > i && /\s/.test(text[end - 1]) && /^(perplexity|chat|wol\.jw\.org|jw\.org|wol|jw):/i.test(text.slice(end))) {
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
    site?: "wol" | "jw" | "perplexity" | "chat",
    phrase?: boolean,
): string {
    const resolvedSite = site || "wol";
    const lang = (settings && settings.outputLanguage) || "en";
    const trimmed = query.trim();

    if (resolvedSite === "perplexity") {
        const q = encodeURIComponent(restrictedQuery(trimmed));
        return `https://www.perplexity.ai/search?q=${q}`;
    }
    if (resolvedSite === "chat") {
        const q = encodeURIComponent(restrictedQuery(trimmed));
        return `https://chatgpt.com/?q=${q}`;
    }

    const q = encodeURIComponent(trimmed).replace(/%20/g, "+");

    if (resolvedSite === "jw") {
        return `https://www.jw.org/en/search/?q=${q}`;
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
