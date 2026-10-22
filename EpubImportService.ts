import { unzipSync } from 'fflate';

function strFromU8(u8: Uint8Array): string {
  return new TextDecoder().decode(u8);
}

async function webCryptoSha256(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as any);
  const arr = Array.from(new Uint8Array(digest));
  return arr.map((b) => b.toString(16).padStart(2, '0')).join('');
}

function posixDirname(p: string): string {
  const idx = p.lastIndexOf('/');
  if (idx === -1) return '.';
  return p.substring(0, idx);
}

function posixJoin(a: string, b: string): string {
  if (b.startsWith('/')) return b;
  if (!a || a === '.') return b;
  return a.endsWith('/') ? `${a}${b}` : `${a}/${b}`;
}

function parseXml(text: string): Document {
  return new DOMParser().parseFromString(text, 'application/xml');
}

export interface OfflineChapter {
  language: string;
  book: string | number;
  chapter: string | number;
  title?: string;
  verses: Record<string, string>;
  source?: {
    sourceFileChecksum?: string;
    importedAt?: string;
  };
}

export interface ImportResult {
  success: boolean;
  error?: string;
  metadata?: { language: string; fileName: string; checksum: string; chapterCount: number; importedAt: string };
}

export class EpubImportService {
  constructor(private repository: any) {}

  private getRootFilePath(archive: Map<string, string>): string | null {
    const container = archive.get('META-INF/container.xml');
    if (!container) return null;
    const match = container.match(/full-path="([^"]+)"/);
    return match ? match[1] : null;
  }

  private findNavPath(opfDoc: Document, rootDir: string): string | null {
    const items = Array.from(opfDoc.getElementsByTagName('item')) as Element[];
    for (const item of items) {
      const props = item.getAttribute('properties') || '';
      const href = item.getAttribute('href');
      if (props.includes('nav') && href) return posixJoin(rootDir, href);
    }
    for (const item of items) {
      const href = item.getAttribute('href') || '';
      if (href.toLowerCase().includes('nav')) return posixJoin(rootDir, href);
    }
    return null;
  }

  private extractNavEntries(navContent: string) {
    const doc = parseXml(navContent);
    const anchors = Array.from(doc.querySelectorAll('nav a')) as HTMLAnchorElement[];
    return anchors.map((a) => ({
      href: a.getAttribute('href') || '',
      text: a.textContent?.trim() || '',
    }));
  }

  private parseBookAndChapter(entryText: string, index: number): { book: number; chapter: number; title: string } {
    const match = entryText.match(/^(.+?)\s+(\d+)$/);
    if (match) {
      const [, bookName, chapterNum] = match;
      return { book: index + 1, chapter: parseInt(chapterNum, 10), title: `${bookName} ${chapterNum}` };
    }
    return { book: index + 1, chapter: 1, title: entryText || `Chapter ${index + 1}` };
  }

  private extractVerses(doc: Document): Record<string, string> {
    const verses: Record<string, string> = {};
    const verseNodes = Array.from(doc.querySelectorAll('[id], [data-verse], .verse')) as Element[];

    for (const el of verseNodes) {
      const candidates = [
        el.getAttribute('data-verse'),
        el.getAttribute('verse'),
        el.getAttribute('id'),
        el.getAttribute('name'),
      ].filter(Boolean) as string[];

      for (const candidate of candidates) {
        const m = candidate.match(/(?:verse[-_]?|v)?(\d{1,3})$/i);
        if (!m) continue;
        const verseNum = m[1];
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (text) {
          verses[verseNum] = text;
          break;
        }
      }
    }

    if (Object.keys(verses).length === 0) {
      const text = (doc.documentElement?.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) verses['1'] = text;
    }

    return verses;
  }

  async importEpub(fileData: Uint8Array, sourceFileName = 'imported.epub', overwriteExisting = false): Promise<ImportResult> {
    try {
      if (!fileData || fileData.length === 0) return { success: false, error: 'No EPUB file provided.' };

      const checksum = `sha256:${await webCryptoSha256(fileData)}`;
      const importedAt = new Date().toISOString();
      const raw = unzipSync(fileData);
      const archive = new Map(Object.entries(raw).map(([p, v]) => [p, strFromU8(v as Uint8Array)]));

      const rootFile = this.getRootFilePath(archive);
      if (!rootFile) return { success: false, error: 'Invalid EPUB: missing container root.' };

      const rootDir = posixDirname(rootFile);
      const opfText = archive.get(rootFile);
      if (!opfText) return { success: false, error: 'Invalid EPUB: missing package document.' };

      const opfDoc = parseXml(opfText);
      const language =
        opfDoc.getElementsByTagName('dc:language')[0]?.textContent?.trim() ||
        opfDoc.getElementsByTagName('language')[0]?.textContent?.trim() ||
        'und';

      const existing = await this.repository.getMetadata(language).catch(() => null);
      if (existing && !overwriteExisting) {
        return { success: false, error: `An offline corpus for ${language} already exists.` };
      }

      const navPath = this.findNavPath(opfDoc, rootDir);
      const chapters: OfflineChapter[] = [];

      if (navPath && archive.has(navPath)) {
        const navContent = archive.get(navPath)!;
        const entries = this.extractNavEntries(navContent);

        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          const [filePart] = entry.href.split('#');
          const contentPath = filePart ? posixJoin(rootDir, filePart) : navPath;
          const chapterDocText = archive.get(contentPath);
          if (!chapterDocText) continue;

          let doc: Document;
          try {
            doc = parseXml(chapterDocText);
          } catch (_) {
            continue;
          }

          const parsed = this.parseBookAndChapter(entry.text, i);
          const verses = this.extractVerses(doc);
          chapters.push({
            language,
            book: parsed.book,
            chapter: parsed.chapter,
            title: parsed.title,
            verses,
            source: {
              sourceFileChecksum: checksum,
              importedAt,
            },
          });
        }
      }

      if (chapters.length === 0) {
        return { success: false, error: 'Unsupported EPUB structure: no chapters found.' };
      }

      const metadata = {
        language,
        fileName: sourceFileName,
        checksum,
        importedAt,
        chapterCount: chapters.length,
      };

      await this.repository.saveCorpus(metadata, chapters);
      return { success: true, metadata };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
