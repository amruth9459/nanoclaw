/**
 * Backfill shared_items from existing messages.
 * Scans messages for links, media, and strategic content the user shared.
 * Run: npx tsx scripts/backfill-shared-items.ts
 */
import { initDatabase, detectSharedItems, storeSharedItem } from '../src/db.js';
import Database from 'better-sqlite3';
import path from 'path';

const STORE_DIR = path.join(process.cwd(), 'store');
const db = new Database(path.join(STORE_DIR, 'messages.db'));

// Initialize NanoClaw DB (creates shared_items table if needed)
initDatabase();

// Find user messages with links, media, or strategic content
const rows = db.prepare(`
  SELECT id, content, sender, sender_name, chat_jid, timestamp, media_type, media_path
  FROM messages
  WHERE is_from_me = 0
    AND is_bot_message = 0
    AND (
      content LIKE '%http%'
      OR media_type IS NOT NULL
      OR content LIKE '%should%'
      OR content LIKE '%idea%'
      OR content LIKE '%look into%'
      OR content LIKE '%want to%'
      OR content LIKE '%I sent this%'
    )
  ORDER BY timestamp DESC
  LIMIT 100
`).all() as Array<{
  id: string;
  content: string;
  sender: string;
  sender_name: string;
  chat_jid: string;
  timestamp: string;
  media_type: string | null;
  media_path: string | null;
}>;

let added = 0;
let skipped = 0;

for (const row of rows) {
  const items = detectSharedItems({
    id: row.id,
    content: row.content,
    sender: row.sender,
    sender_name: row.sender_name,
    chat_jid: row.chat_jid,
    timestamp: row.timestamp,
    media_type: row.media_type,
    media_path: row.media_path,
  });

  for (const item of items) {
    if (storeSharedItem(item)) {
      console.log(`+ ${item.item_type}: ${item.content.slice(0, 80)}`);
      added++;
    } else {
      skipped++;
    }
  }
}

console.log(`\nDone: ${added} items added, ${skipped} duplicates skipped`);
