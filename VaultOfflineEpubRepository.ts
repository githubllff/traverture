import type { App } from 'obsidian';

export interface CorpusMetadata {
  language: string;
  fileName: string;
  checksum: string;
  importedAt: string;
  chapterCount?: number;
}

export interface OfflineChapter {
  language: string;
  book: number | string;
  chapter: number | string;
  title?: string;
  verses: Record<string, string>;
  source?: {
    sourceFileChecksum?: string;
    importedAt?: string;
  };
}

export class VaultOfflineEpubRepository {
  private basePath: string;

  constructor(private app: App, private pluginId: string) {
    this.basePath = `.${pluginId}/offline-epub`;
  }

  private async ensureFolder(path: string) {
    try {
      await this.app.vault.createFolder(path);
    } catch (_) {
      // ignore if exists
    }
  }

  private getMetadataPath(language: string): string {
    return `${this.basePath}/${language}.metadata.json`;
  }

  private getIndexPath(language: string): string {
    return `${this.basePath}/${language}.index.json`;
  }

  private getLegacyCorpusPath(language: string): string {
    return `${this.basePath}/${language}.corpus.json`;
  }

  private getChapterPath(language: string, book: number | string, chapter: number | string): string {
    const bookKey = String(book).padStart(3, '0');
    const chapterKey = String(chapter).padStart(3, '0');
    return `${this.basePath}/${language}/${bookKey}/${chapterKey}.json`;
  }

  private async ensureChapterFolder(language: string, book: number | string): Promise<void> {
    await this.ensureFolder(this.basePath);
    await this.ensureFolder(`${this.basePath}/${language}`);
    await this.ensureFolder(`${this.basePath}/${language}/${String(book).padStart(3, '0')}`);
  }

  async saveCorpus(metadata: CorpusMetadata, chapters: OfflineChapter[]): Promise<void> {
    const normalizedMetadata: CorpusMetadata = {
      ...metadata,
      importedAt: metadata.importedAt || new Date().toISOString(),
      chapterCount: metadata.chapterCount ?? chapters.length,
    };

    await this.ensureFolder(this.basePath);
    await this.app.vault.adapter.write(this.getMetadataPath(metadata.language), JSON.stringify(normalizedMetadata, null, 2));

    const index = chapters.map((chapter) => ({
      language: chapter.language,
      book: chapter.book,
      chapter: chapter.chapter,
      title: chapter.title ?? '',
    }));
    await this.app.vault.adapter.write(this.getIndexPath(metadata.language), JSON.stringify(index, null, 2));

    for (const chapter of chapters) {
      await this.saveChapter(metadata.language, chapter);
    }

    try {
      await this.app.vault.adapter.remove(this.getLegacyCorpusPath(metadata.language));
    } catch (_) {
      // ignore missing legacy corpus file
    }
  }

  async saveChapter(language: string, chapter: OfflineChapter): Promise<void> {
    await this.ensureChapterFolder(language, chapter.book);
    const chapterPath = this.getChapterPath(language, chapter.book, chapter.chapter);
    await this.app.vault.adapter.write(chapterPath, JSON.stringify(chapter, null, 2));
  }

  async getMetadata(language: string): Promise<CorpusMetadata | null> {
    try {
      const text = await this.app.vault.adapter.read(this.getMetadataPath(language));
      return JSON.parse(text) as CorpusMetadata;
    } catch (_) {
      return null;
    }
  }

  async hasLanguage(language: string): Promise<boolean> {
    return (await this.getMetadata(language)) !== null;
  }

  async getCorpusIndex(language: string): Promise<Array<{ language: string; book: number | string; chapter: number | string; title?: string }> | null> {
    try {
      const text = await this.app.vault.adapter.read(this.getIndexPath(language));
      return JSON.parse(text);
    } catch (_) {
      return null;
    }
  }

  async getCorpus(language: string): Promise<OfflineChapter[] | null> {
    const index = await this.getCorpusIndex(language);
    if (index && index.length > 0) {
      const chapters: OfflineChapter[] = [];
      for (const entry of index) {
        const chapter = await this.getChapter(language, entry.book, entry.chapter);
        if (chapter) chapters.push(chapter);
      }
      return chapters;
    }

    try {
      const text = await this.app.vault.adapter.read(this.getLegacyCorpusPath(language));
      return JSON.parse(text) as OfflineChapter[];
    } catch (_) {
      return null;
    }
  }

  async getChapter(language: string, book: number | string, chapter: number | string): Promise<OfflineChapter | null> {
    try {
      const text = await this.app.vault.adapter.read(this.getChapterPath(language, book, chapter));
      return JSON.parse(text) as OfflineChapter;
    } catch (_) {
      const corpus = await this.getCorpus(language);
      if (!corpus) return null;
      return corpus.find((entry) => String(entry.book) === String(book) && String(entry.chapter) === String(chapter)) ?? null;
    }
  }

  async getVerseRange(
    language: string,
    book: number | string,
    chapter: number | string,
    verseStart: number,
    verseEnd?: number,
  ): Promise<string | null> {
    const chapterData = await this.getChapter(language, book, chapter);
    if (!chapterData?.verses) return null;

    const end = verseEnd ?? verseStart;
    const verses: string[] = [];
    for (let verse = verseStart; verse <= end; verse++) {
      const text = chapterData.verses[String(verse)];
      if (text) verses.push(text.trim());
    }
    return verses.length > 0 ? verses.join(' ') : null;
  }

  async listLanguages(): Promise<string[]> {
    try {
      const items = await this.app.vault.adapter.list(this.basePath);
      return items.files
        .map((file) => file.split('/').pop() || '')
        .filter((name) => name.endsWith('.metadata.json'))
        .map((name) => name.replace(/\.metadata\.json$/, ''));
    } catch (_) {
      return [];
    }
  }

  async removeLanguage(language: string): Promise<void> {
    const paths = [
      this.getMetadataPath(language),
      this.getIndexPath(language),
      this.getLegacyCorpusPath(language),
    ];

    for (const path of paths) {
      try {
        await this.app.vault.adapter.remove(path);
      } catch (_) {}
    }

    const languageFolder = `${this.basePath}/${language}`;
    try {
      const listed = await this.app.vault.adapter.list(languageFolder);
      for (const file of listed.files) {
        try {
          await this.app.vault.adapter.remove(file);
        } catch (_) {}
      }
      const folders = [...listed.folders].sort((a, b) => b.length - a.length);
      for (const folder of folders) {
        try {
          await this.app.vault.adapter.rmdir(folder, true);
        } catch (_) {}
      }
      await this.app.vault.adapter.rmdir(languageFolder, true);
    } catch (_) {
      // ignore missing folder
    }
  }
}
