import {embeddedSource} from "../shared/embedded-source.js";
import type { DatabaseSync } from 'node:sqlite';
import {BridgeError} from '../shared/errors.js';

const VERSION = 5;

                                
export function initializeSchema(db: DatabaseSync): void {
  db.exec(                          embeddedSource("sql", `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000`));
  const version = Number(db.prepare(                          embeddedSource("sql", `PRAGMA user_version`)).get()?.user_version ?? 0);
  if (version > VERSION) throw new BridgeError('schema_newer', '数据库来自较新版本，请使用相应版本，不能直接降级。');
                                          
  db.exec(                          embeddedSource("sql", `PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE`));
  try {
    db.exec(                          embeddedSource("sql", `
      CREATE TABLE IF NOT EXISTS peers(id TEXT PRIMARY KEY,host TEXT NOT NULL,session_id TEXT,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS endpoints(peer_id TEXT NOT NULL REFERENCES peers(id),epoch TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(peer_id,epoch));
      CREATE TABLE IF NOT EXISTS pairs(id TEXT PRIMARY KEY,claude TEXT NOT NULL REFERENCES peers(id),codex TEXT NOT NULL REFERENCES peers(id),paused INTEGER NOT NULL DEFAULT 0,archived INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,pair_id TEXT NOT NULL REFERENCES pairs(id),sender TEXT NOT NULL REFERENCES peers(id),recipient TEXT NOT NULL REFERENCES peers(id),body TEXT NOT NULL,in_reply_to TEXT REFERENCES messages(id),via TEXT,call_id TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,evidence TEXT,error TEXT,attempts INTEGER NOT NULL DEFAULT 0,UNIQUE(sender,call_id));
      CREATE INDEX IF NOT EXISTS messages_pending ON messages(recipient,state,created_at);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,created_at INTEGER NOT NULL,type TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS questions(id TEXT PRIMARY KEY,pair_id TEXT NOT NULL,actor_key TEXT NOT NULL UNIQUE,status TEXT NOT NULL,expires_at INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS questions_active ON questions(status,expires_at);
      CREATE INDEX IF NOT EXISTS events_age ON events(created_at)`));
    if (version < VERSION) {
      db.exec(                          embeddedSource("sql", `CREATE TABLE peers_v5(id TEXT PRIMARY KEY,host TEXT NOT NULL,session_id TEXT,data TEXT NOT NULL);
        INSERT INTO peers_v5 SELECT id,host,session_id,data FROM peers;
        DROP TABLE peers; ALTER TABLE peers_v5 RENAME TO peers;
        DROP INDEX IF EXISTS one_current_pair`));
    }
    const column = (table: string, name: string, definition: string) => {
      if (!db.prepare('PRAGMA table_info(' + table + ')').all().some(r => r.name === name)) db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + name + ' ' + definition);
    };
    column('settings', 'updated_at', 'INTEGER NOT NULL DEFAULT 0');
                                                 
    db.exec(                          embeddedSource("sql", `DELETE FROM settings WHERE key GLOB 'ownedNative:*'`));
    db.exec(                          embeddedSource("sql", `DROP TABLE IF EXISTS owned_processes`));
    column('pairs', 'archived_at', 'INTEGER');
    column('messages', 'original_reply_to', 'TEXT');
    column('messages', 'reply_source', 'TEXT');
    column('messages', 'reply_expected', 'INTEGER NOT NULL DEFAULT 0');
    column('messages', 'delivery_epoch', 'TEXT');
    if (!db.prepare(                          embeddedSource("sql", `PRAGMA table_info(messages)`)).all().some(r => r.name === 'snapshot_required')) {
      column('messages', 'snapshot_required', 'INTEGER NOT NULL DEFAULT 0');
      db.exec(                          embeddedSource("sql", `UPDATE messages SET snapshot_required=1 WHERE EXISTS (SELECT 1 FROM settings WHERE key='ref:message:'||messages.id)
        OR (instr(body,'nxref:')>0 AND call_id NOT LIKE 'question:%' AND call_id NOT LIKE 'question-result:%')`));
    }
    db.exec(                          embeddedSource("sql", `CREATE INDEX IF NOT EXISTS peers_session ON peers(host,session_id);
      CREATE UNIQUE INDEX IF NOT EXISTS active_claude_member ON pairs(claude) WHERE archived=0;
      CREATE UNIQUE INDEX IF NOT EXISTS active_codex_member ON pairs(codex) WHERE archived=0;
      CREATE TABLE IF NOT EXISTS window_bindings(key TEXT PRIMARY KEY,peer_id TEXT NOT NULL REFERENCES peers(id) ON DELETE CASCADE,active INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS active_peer_window ON window_bindings(peer_id) WHERE active=1;
      CREATE TABLE IF NOT EXISTS session_lineage(peer_id TEXT NOT NULL REFERENCES peers(id) ON DELETE CASCADE,host TEXT NOT NULL,config_home TEXT NOT NULL,session_id TEXT NOT NULL,epoch TEXT NOT NULL,reason TEXT NOT NULL,observed_at INTEGER NOT NULL,PRIMARY KEY(peer_id,epoch));
      CREATE INDEX IF NOT EXISTS lineage_session ON session_lineage(host,config_home,session_id);
      CREATE TABLE IF NOT EXISTS context_notices(id TEXT PRIMARY KEY,pair_id TEXT NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,recipient TEXT NOT NULL REFERENCES peers(id) ON DELETE CASCADE,data TEXT NOT NULL,acknowledged INTEGER NOT NULL DEFAULT 0)`));
    db.exec(                          embeddedSource("sql", `CREATE TABLE IF NOT EXISTS pair_selections(id TEXT PRIMARY KEY,peer_id TEXT NOT NULL REFERENCES peers(id) ON DELETE CASCADE,call_key TEXT NOT NULL UNIQUE,code TEXT NOT NULL,status TEXT NOT NULL,expires_at INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS active_pairing_code ON pair_selections(code) WHERE status='pending';
      CREATE INDEX IF NOT EXISTS selections_caller ON pair_selections(peer_id,status)`));
    db.prepare(                          embeddedSource("sql", `UPDATE settings SET updated_at=? WHERE updated_at=0`)).run(Date.now());
    if (db.prepare(                          embeddedSource("sql", `PRAGMA foreign_key_check`)).all().length) throw new BridgeError('migration_relations', '数据库关系不完整，迁移已回滚，请保留原数据库检查。');
    db.exec('PRAGMA user_version=' + VERSION + '; COMMIT');
  } catch (error) {
    db.exec(                          embeddedSource("sql", `ROLLBACK`));
    throw error;
  } finally {
    db.exec(                          embeddedSource("sql", `PRAGMA foreign_keys=ON`));
  }
}
