// post-processor.ts

import { findCitations, buildDelimitedUrl, getDelimitedQuery } from './inrefens-engine-wrapper';
import { Citation } from './inrefens-types';

export function processElement(el: HTMLElement): void {
    if (isInsideAnchor(el)) return;
    if (el.querySelector('.callout')) return;
    const hasRealSvg = [...el.querySelectorAll('svg')].some(
        svg => !svg.closest('.list-bullet')
    );
    if (hasRealSvg && !el.querySelector('h1, h2, h3, h4, h5, h6, ul, ol')) return;
    if (el.classList.contains('inrefens-processed')) return;
    el.classList.add('inrefens-processed');
    handleDelimitedElements(el);
    processInlineRuns(el);
    processTextNodes(el);
}

function isInsideAnchor(node: Node): boolean {
    const el = node.nodeType === Node.ELEMENT_NODE
        ? node as Element
        : node.parentElement;
    return !!el?.closest('a');
}

// ──────────────────────────────────────────────
// Delimited citations (*** ... ***)
// ──────────────────────────────────────────────

function handleDelimitedElements(el: HTMLElement): void {
    const candidates: HTMLElement[] = [];

    el.querySelectorAll('strong > em, em > strong').forEach((node) => {
        const parent = (node as HTMLElement).parentElement;
        if (!parent) return;
        if (parent.closest('.inrefens-link')) return;
        candidates.push(parent);
    });

    for (const em of candidates) {
        const text = em.textContent || '';
        if (!text) continue;
        const url = buildDelimitedUrl(text);
        if (!url) continue;
        const query = getDelimitedQuery(text);

        const anchor = createEl('a');
        anchor.className = 'inrefens-link';
        anchor.href = url;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        anchor.setAttribute('data-inrefens-query', query);

        while (em.firstChild) {
            anchor.appendChild(em.firstChild);
        }
        em.replaceWith(anchor);
    }
}

// ──────────────────────────────────────────────
// Run-based pass
// ──────────────────────────────────────────────

function isInlineContainer(tagName: string): boolean {
    return tagName === 'EM' || tagName === 'STRONG';
}

function isDisqualifying(tagName: string): boolean {
    return tagName === 'CODE' || tagName === 'PRE' || tagName === 'A';
}

interface RunChild {
    node: Node;
    text: string;
    start: number;
}

function collectRun(children: Node[], startIndex: number): { children: RunChild[]; endIndex: number } | null {
    const run: RunChild[] = [];
    let i = startIndex;

    while (i < children.length) {
        const child = children[i];

        if (child.nodeType === Node.TEXT_NODE) {
            run.push({ node: child, text: child.nodeValue || '', start: 0 });
            i++;
            continue;
        }

        if (child.nodeType === Node.ELEMENT_NODE) {
            const elem = child as HTMLElement;

            if (isInsideAnchor(elem)) break;
            if (elem.classList.contains('inrefens-link')) break;
            if (isDisqualifying(elem.tagName)) return null;
            if (!isInlineContainer(elem.tagName)) break;

            let allText = true;
            let text = '';
            for (const inner of Array.from(elem.childNodes)) {
                if (inner.nodeType === Node.TEXT_NODE) {
                    text += inner.nodeValue || '';
                } else {
                    allText = false;
                    break;
                }
            }
            if (!allText) return null;

            run.push({ node: child, text, start: 0 });
            i++;
            continue;
        }

        break;
    }

    if (run.length === 0) return null;
    return { children: run, endIndex: i - 1 };
}

function flattenRun(run: RunChild[]): string {
    let pos = 0;
    let out = '';
    for (const rc of run) {
        rc.start = pos;
        out += rc.text;
        pos += rc.text.length;
    }
    return out;
}

function replaceRunRange(run: RunChild[], from: number, to: number, url: string, query: string): void {
    const first = run[0];
    const parent = first.node.parentNode;
    if (!parent) return;

    const fragment = createFragment();

    for (const rc of run) {
        const rcEnd = rc.start + rc.text.length;
        if (rcEnd <= from) {
            fragment.appendChild(rc.node.cloneNode(true));
        } else if (rc.start < from) {
            fragment.appendChild(clipNode(rc.node, 0, from - rc.start));
        } else {
            break;
        }
    }

    const anchor = createEl('a');
    anchor.className = 'inrefens-link';
    anchor.href = url;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.setAttribute('data-inrefens-query', query);

    for (const rc of run) {
        const rcEnd = rc.start + rc.text.length;
        if (rcEnd <= from) continue;
        if (rc.start >= to) break;
        const localFrom = Math.max(0, from - rc.start);
        const localTo = Math.min(rc.text.length, to - rc.start);
        anchor.appendChild(clipNode(rc.node, localFrom, localTo));
    }

    fragment.appendChild(anchor);

    for (const rc of run) {
        const rcEnd = rc.start + rc.text.length;
        if (rcEnd <= to) continue;
        const localFrom = Math.max(0, to - rc.start);
        fragment.appendChild(clipNode(rc.node, localFrom, rc.text.length));
    }

    parent.insertBefore(fragment, first.node);
    for (const rc of run) {
        parent.removeChild(rc.node);
    }
}

function clipNode(source: Node, from: number, to: number): Node {
    if (from >= to) return activeDocument.createTextNode('');

    if (source.nodeType === Node.TEXT_NODE) {
        const text = source.nodeValue || '';
        return activeDocument.createTextNode(text.substring(from, to));
    }

    const clone = (source as Element).cloneNode(false) as Element;
    let pos = 0;
    for (const inner of Array.from(source.childNodes)) {
        if (inner.nodeType !== Node.TEXT_NODE) continue;
        const text = inner.nodeValue || '';
        const innerStart = pos;
        const innerEnd = pos + text.length;
        pos = innerEnd;

        const sliceStart = Math.max(from, innerStart);
        const sliceEnd = Math.min(to, innerEnd);
        if (sliceStart >= sliceEnd) continue;

        clone.appendChild(
            activeDocument.createTextNode(text.substring(sliceStart - innerStart, sliceEnd - innerStart)),
        );
    }
    return clone;
}

function processInlineRuns(el: HTMLElement): void {
    for (const block of collectBlockElements(el)) {
        processBlockElement(block);
    }
}

function collectBlockElements(root: HTMLElement): HTMLElement[] {
    const out: HTMLElement[] = [];
    const walk = (node: HTMLElement) => {
        out.push(node);
        for (const child of Array.from(node.children)) {
            if (child.instanceOf(HTMLElement)) walk(child);
        }
    };
    walk(root);
    return out;
}

function processBlockElement(block: HTMLElement): void {
    let children: Node[] = Array.from(block.childNodes);
    let i = 0;

    while (i < children.length) {
        const child = children[i];

        if (child.nodeType === Node.ELEMENT_NODE) {
            const elem = child as HTMLElement;
            if (isInsideAnchor(elem)) { i++; continue; }
            if (elem.classList.contains('inrefens-link')) { i++; continue; }
            if (isDisqualifying(elem.tagName)) { i++; continue; }
            if (!isInlineContainer(elem.tagName)) { i++; continue; }
        }

        const run = collectRun(children, i);
        if (!run) { i++; continue; }

        const flat = flattenRun(run.children);
        if (!flat.trim()) { i = run.endIndex + 1; continue; }

        const citations = findCitations(flat);
        if (!citations || citations.length === 0) { i = run.endIndex + 1; continue; }

        const sorted = [...citations].sort((a, b) => b.start - a.start);
        for (const c of sorted) {
            if (c.end <= c.start) continue;
            if (!c.wol_url) continue;
            replaceRunRange(run.children, c.start, c.end, c.wol_url, c.parts?.query || '');
        }

        children = Array.from(block.childNodes);
        i = Math.min(i + 1, children.length);
    }
}

// ──────────────────────────────────────────────
// Fallback: per-text-node walker
// ──────────────────────────────────────────────

function processTextNodes(el: HTMLElement): void {
    const walker = activeDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            if (parent.tagName === 'A') return NodeFilter.FILTER_REJECT;
            if (parent.tagName === 'CODE') return NodeFilter.FILTER_REJECT;
            if (parent.tagName === 'PRE') return NodeFilter.FILTER_REJECT;
            if (parent.closest('.inrefens-link')) return NodeFilter.FILTER_REJECT;
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

        const citations = findCitations(text);
        if (!citations || citations.length === 0) continue;

        replaceTextNode(textNode, text, citations);
    }
}

function replaceTextNode(textNode: Text, text: string, citations: Citation[]): void {
    const sortedAscending = [...citations].sort((a, b) => a.start - b.start);
    const fragment = createFragment();
    let pos = 0;

    for (const citation of sortedAscending) {
        if (citation.start > pos) {
            fragment.appendChild(activeDocument.createTextNode(text.substring(pos, citation.start)));
        }
        const anchor = createEl('a');
        anchor.className = 'inrefens-link';
        anchor.href = citation.wol_url;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        anchor.textContent = citation.text;
        const query = citation.parts?.query;
        if (query) {
            anchor.setAttribute('data-inrefens-query', query);
        }
        fragment.appendChild(anchor);
        pos = citation.end;
    }

    if (pos < text.length) {
        fragment.appendChild(activeDocument.createTextNode(text.substring(pos)));
    }

    textNode.parentNode?.replaceChild(fragment, textNode);
}