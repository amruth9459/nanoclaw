/**
 * Context System — barrel file
 *
 * Re-exports the three tiers:
 * - Tier 1: Codified facts (in-memory, instant)
 * - Tier 2: Semantic search (embedding-based, stub until configured)
 * - Tier 3: Perplexity web search (external API, stub until API key set)
 * - Context Manager: orchestrates all tiers
 */

export { contextManager } from './context-manager.js';
export {
  codedContext,
  setSystemFact,
  setUserPreference,
  learnFact,
  setActiveProject,
  setCapability,
} from './codified-context.js';
export { semanticSearch } from './semantic-search.js';
export { perplexity } from './perplexity-integration.js';
