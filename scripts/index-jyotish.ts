/**
 * Trigger semantic indexing for jyotish knowledge chunks.
 * Run: npx tsx scripts/index-jyotish.ts
 */
import { indexGroupFiles } from '../src/semantic-index.js';

async function main() {
  console.log('Starting semantic indexing for main group...');
  console.log('This indexes all .txt and .json files in groups/main/output/');
  const start = Date.now();
  await indexGroupFiles('main');
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`Done in ${elapsed}s`);
}

main().catch(err => {
  console.error('Indexing failed:', err);
  process.exit(1);
});
