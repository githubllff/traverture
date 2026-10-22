export type LinkScheme = 'popup' | 'jwlibrary' | 'jworg';

export const DEFAULT_LINK_SCHEME: LinkScheme = 'jwlibrary';

type FinderReferenceParams = {
  bibleId?: string;
  book?: string;
  chapter?: number;
  verseStart?: number;
  verseEnd?: number;
  extra?: Record<string, string>;
};

function buildFinderQuery(params: FinderReferenceParams): string {
  const q = new URLSearchParams();
  if (params.bibleId) q.set('bible', params.bibleId);
  if (params.book) q.set('book', params.book);
  if (params.chapter !== undefined) q.set('chapter', String(params.chapter));
  if (params.verseStart !== undefined) {
    q.set(
      'verse',
      params.verseEnd !== undefined
        ? `${params.verseStart}-${params.verseEnd}`
        : String(params.verseStart),
    );
  }
  if (params.extra) {
    for (const [key, value] of Object.entries(params.extra)) {
      q.set(key, value);
    }
  }
  return q.toString();
}

export function buildJwLibraryFinderUrlForReference(
  params: FinderReferenceParams,
): string {
  return `jwlibrary:///finder?${buildFinderQuery(params)}`;
}

export function buildJwOrgFinderUrlForReference(
  params: FinderReferenceParams,
): string {
  return `jworg://finder?${buildFinderQuery(params)}`;
}

export function buildFinderUrlForReference(
  scheme: LinkScheme,
  params: FinderReferenceParams,
): string {
  return scheme === 'jworg'
    ? buildJwOrgFinderUrlForReference(params)
    : buildJwLibraryFinderUrlForReference(params);
}
