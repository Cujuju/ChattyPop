// Indexes plugin link text or Discord previews in fts_links using links.id. Triggers synchronize links and link_texts.
import type { Db } from './db';
import { linkTextSql } from './queries/messageText';

/** Re-indexes the links matching `where` (over links alias `l`); a link with no text has no row. */
const reindexSql = (where: string): string => `
    DELETE FROM fts_links WHERE rowid IN (SELECT l.id FROM links l WHERE ${where});
    INSERT INTO fts_links (rowid, text)
      SELECT id, text FROM (SELECT l.id, ${linkTextSql('l')} AS text FROM links l WHERE ${where}) WHERE text IS NOT NULL;`;

/** The index and its triggers. Live, not frozen: a change to linkTextSql appends refreshLinkSearch as a migration. */
const LINK_SEARCH = `
  CREATE VIRTUAL TABLE fts_links USING fts5(text);
  CREATE TRIGGER links_search_ai AFTER INSERT ON links BEGIN ${reindexSql('l.id = new.id')} END;
  CREATE TRIGGER links_search_au AFTER UPDATE OF url, title, description ON links
    WHEN old.url IS NOT new.url OR old.title IS NOT new.title OR old.description IS NOT new.description
    BEGIN ${reindexSql('l.id = new.id')} END;
  CREATE TRIGGER links_search_ad AFTER DELETE ON links BEGIN DELETE FROM fts_links WHERE rowid = old.id; END;
  CREATE TRIGGER link_texts_search_ai AFTER INSERT ON link_texts BEGIN ${reindexSql('l.url = new.url')} END;
  CREATE TRIGGER link_texts_search_au AFTER UPDATE ON link_texts BEGIN ${reindexSql('l.url = old.url')} ${reindexSql('l.url = new.url')} END;
  CREATE TRIGGER link_texts_search_ad AFTER DELETE ON link_texts BEGIN ${reindexSql('l.url = old.url')} END;
`;

/** Creates or recreates the link search index and its triggers, indexing every stored link. */
export function refreshLinkSearch(db: Db): void {
  for (const [, name] of LINK_SEARCH.matchAll(/CREATE TRIGGER (\w+)/g)) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
  db.exec('DROP TABLE IF EXISTS fts_links');
  db.exec(`${LINK_SEARCH} ${reindexSql('1')}`);
}
