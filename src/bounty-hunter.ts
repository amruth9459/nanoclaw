/**
 * Bounty Hunter — fetches open bounties from Algora and GitHub.
 * Uses Node.js native fetch; no external HTTP libraries needed.
 */

import { GITHUB_TOKEN } from './config.js';
import { logger } from './logger.js';

export interface Bounty {
  id: string;            // 'algora:12345' or 'github:98765' or 'reddit:abc123'
  platform: 'algora' | 'github' | 'reddit' | 'freelancer';
  title: string;
  url: string;
  reward_usd: number | null;
  reward_raw: string;    // e.g. "500 USD", "$250"
  description: string;
  repo?: string;
}

/** Fetch open bounties from Algora.io */
export async function findAlgoraBounties(limit = 20): Promise<Bounty[]> {
  try {
    const res = await fetch(
      `https://algora.io/api/v1/bounties?state=open&limit=${limit}`,
      { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(15000) },
    );
    if (!res.ok) {
      logger.warn({ status: res.status }, 'Algora API returned non-200');
      return [];
    }
    const raw = await res.json() as unknown;
    const items: Bounty[] = [];

    // Algora returns { data: [...] } or just an array — handle both
    const list = Array.isArray(raw) ? raw : (raw as { data?: unknown[] }).data ?? [];

    for (const item of list as Record<string, unknown>[]) {
      const id = String(item.id ?? item.number ?? Math.random());
      const rewardUsd = typeof item.reward_usd === 'number' ? item.reward_usd
        : typeof item.reward === 'number' ? item.reward
        : null;
      const rewardRaw = String(item.reward_formatted ?? item.reward_raw ?? (rewardUsd ? `$${rewardUsd}` : 'Unknown'));
      items.push({
        id: `algora:${id}`,
        platform: 'algora',
        title: String(item.title ?? item.summary ?? 'Untitled'),
        url: String(item.url ?? item.html_url ?? `https://algora.io/bounties/${id}`),
        reward_usd: rewardUsd,
        reward_raw: rewardRaw,
        description: String(item.description ?? item.body ?? '').slice(0, 500),
        repo: typeof item.repo === 'string' ? item.repo
          : typeof item.repository === 'string' ? item.repository
          : undefined,
      });
    }
    logger.info({ count: items.length }, 'Algora bounties fetched');
    return items;
  } catch (err) {
    logger.warn({ err }, 'findAlgoraBounties failed');
    return [];
  }
}

/** Fetch open bounty-labeled issues from GitHub */
export async function findGithubBounties(limit = 20): Promise<Bounty[]> {
  try {
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (GITHUB_TOKEN) headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;

    const res = await fetch(
      `https://api.github.com/search/issues?q=label%3Abounty+state%3Aopen+is%3Aissue&sort=created&per_page=${limit}`,
      { headers, signal: AbortSignal.timeout(15000) },
    );
    if (!res.ok) {
      logger.warn({ status: res.status }, 'GitHub API returned non-200');
      return [];
    }

    const raw = await res.json() as { items?: Record<string, unknown>[] };
    const list = raw.items ?? [];
    const items: Bounty[] = [];

    for (const item of list) {
      const id = String(item.number ?? item.id ?? Math.random());
      // Try to extract a USD amount from the title or body
      const text = `${item.title ?? ''} ${item.body ?? ''}`;
      const dollarMatch = text.match(/\$\s?(\d[\d,]*(?:\.\d+)?)/);
      const rewardUsd = dollarMatch ? parseFloat(dollarMatch[1].replace(/,/g, '')) : null;
      const rewardRaw = dollarMatch ? dollarMatch[0] : 'see issue';

      // Extract repo from repository_url: "https://api.github.com/repos/owner/name"
      const repoUrl = String(item.repository_url ?? '');
      const repoMatch = repoUrl.match(/repos\/(.+)$/);
      const repo = repoMatch ? repoMatch[1] : undefined;

      items.push({
        id: `github:${id}`,
        platform: 'github',
        title: String(item.title ?? 'Untitled'),
        url: String(item.html_url ?? `https://github.com/issues/${id}`),
        reward_usd: rewardUsd,
        reward_raw: rewardRaw,
        description: String(item.body ?? '').slice(0, 500),
        repo,
      });
    }
    logger.info({ count: items.length }, 'GitHub bounties fetched');
    return items;
  } catch (err) {
    logger.warn({ err }, 'findGithubBounties failed');
    return [];
  }
}

/**
 * Fetch bounties from Boss.dev (GitHub-integrated open source bounty board).
 * Boss.dev uses GitHub labels — we search for repos that use Boss.dev conventions.
 */
export async function findBossDevBounties(token?: string, limit = 20): Promise<Bounty[]> {
  try {
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    // Boss.dev bounties are GitHub issues labeled 'boss.dev' or 'bossdev'
    const res = await fetch(
      `https://api.github.com/search/issues?q=label%3Aboss.dev+state%3Aopen+is%3Aissue&sort=created&per_page=${limit}`,
      { headers, signal: AbortSignal.timeout(15000) },
    );
    if (!res.ok) return [];

    const raw = await res.json() as { items?: Record<string, unknown>[] };
    const list = raw.items ?? [];
    const items: Bounty[] = [];

    for (const item of list) {
      const id = String(item.number ?? item.id);
      const text = `${item.title ?? ''} ${item.body ?? ''}`;
      const dollarMatch = text.match(/\$\s?(\d[\d,]*(?:\.\d+)?)/);
      const rewardUsd = dollarMatch ? parseFloat(dollarMatch[1].replace(/,/g, '')) : null;
      const repoUrl = String(item.repository_url ?? '');
      const repoMatch = repoUrl.match(/repos\/(.+)$/);

      items.push({
        id: `bossdev:${id}`,
        platform: 'github',
        title: String(item.title ?? 'Untitled'),
        url: String(item.html_url ?? `https://github.com/issues/${id}`),
        reward_usd: rewardUsd,
        reward_raw: dollarMatch ? dollarMatch[0] : 'see boss.dev',
        description: String(item.body ?? '').slice(0, 500),
        repo: repoMatch ? repoMatch[1] : undefined,
      });
    }
    logger.info({ count: items.length }, 'Boss.dev bounties fetched');
    return items;
  } catch (err) {
    logger.warn({ err }, 'findBossDevBounties failed');
    return [];
  }
}

/**
 * Fetch AI/ML bug bounty programs from Huntr.dev.
 * Huntr pays $500-$1500 per valid vulnerability report in AI/ML libraries.
 * We return the Huntr landing page as a single "meta-bounty" entry since
 * their API requires authentication — the agent can browse specific programs.
 */
export function getHuntrBountyInfo(): Bounty[] {
  return [
    {
      id: 'huntr:ai-ml-bounty-program',
      platform: 'algora',
      title: 'Huntr AI/ML Bug Bounty — $500–$1,500 per vulnerability',
      url: 'https://huntr.com/',
      reward_usd: 1000,
      reward_raw: '$500–$1,500 per valid report',
      description: 'World\'s first AI/ML bug bounty platform. 240+ programs. Find security vulnerabilities in popular AI/ML Python libraries (numpy, pandas, scikit-learn, transformers, etc.). Report format: PoC script that triggers the bug, affected version, impact assessment. Rewards paid in USD within 31 days. No login required to browse programs.',
    },
    {
      id: 'huntr:anthropic-safety-bounty',
      platform: 'algora',
      title: 'Anthropic Model Safety Bug Bounty — up to $35,000',
      url: 'https://www.anthropic.com/security',
      reward_usd: 10000,
      reward_raw: '$250–$35,000',
      description: 'Anthropic pays for novel universal jailbreaks and safety vulnerabilities in Claude models. Highest tier: $35,000 for novel universal jailbreak. Focus on finding inputs that cause consistently unsafe outputs across model versions.',
    },
  ];
}

/** Fetch [HIRING] posts from r/forhire via Reddit's public JSON API */
export async function findRedditGigs(limit = 20): Promise<Bounty[]> {
  try {
    const res = await fetch(
      `https://www.reddit.com/r/forhire/search.json?q=flair%3A%22Hiring%22&restrict_sr=on&sort=new&limit=${limit}`,
      { headers: { 'User-Agent': 'NanoClaw/1.0' }, signal: AbortSignal.timeout(15000) },
    );
    if (!res.ok) {
      logger.warn({ status: res.status }, 'Reddit r/forhire API returned non-200');
      return [];
    }
    const raw = await res.json() as { data?: { children?: Array<{ data: Record<string, unknown> }> } };
    const posts = raw.data?.children ?? [];
    const items: Bounty[] = [];

    for (const { data: post } of posts) {
      const title = String(post.title ?? '');
      const id = String(post.id ?? Math.random());
      const dollarMatch = title.match(/\$\s?(\d[\d,]*(?:\.\d+)?)/);
      const rewardUsd = dollarMatch ? parseFloat(dollarMatch[1].replace(/,/g, '')) : null;

      items.push({
        id: `reddit:${id}`,
        platform: 'reddit',
        title,
        url: `https://www.reddit.com${post.permalink ?? `/r/forhire/comments/${id}`}`,
        reward_usd: rewardUsd,
        reward_raw: dollarMatch ? dollarMatch[0] : 'see post',
        description: String(post.selftext ?? '').slice(0, 500),
      });
    }
    logger.info({ count: items.length }, 'Reddit r/forhire gigs fetched');
    return items;
  } catch (err) {
    logger.warn({ err }, 'findRedditGigs failed');
    return [];
  }
}

/** Fetch active projects from Freelancer.com public API */
export async function findFreelancerGigs(limit = 20): Promise<Bounty[]> {
  try {
    const res = await fetch(
      `https://www.freelancer.com/api/projects/0.1/projects/active/?compact=true&limit=${limit}&job_details=true&sort_field=submitdate&sort_direction=desc`,
      { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(15000) },
    );
    if (!res.ok) {
      logger.warn({ status: res.status }, 'Freelancer.com API returned non-200');
      return [];
    }
    const raw = await res.json() as { result?: { projects?: Record<string, unknown>[] } };
    const projects = raw.result?.projects ?? [];
    const items: Bounty[] = [];

    for (const proj of projects) {
      const id = String(proj.id ?? Math.random());
      const budget = proj.budget as { maximum?: number; minimum?: number } | undefined;
      const rewardUsd = budget?.maximum ?? budget?.minimum ?? null;

      items.push({
        id: `freelancer:${id}`,
        platform: 'freelancer',
        title: String(proj.title ?? 'Untitled'),
        url: `https://www.freelancer.com/projects/${proj.seo_url ?? id}`,
        reward_usd: rewardUsd,
        reward_raw: rewardUsd != null ? `$${rewardUsd}` : 'see project',
        description: String(proj.preview_description ?? proj.description ?? '').slice(0, 500),
      });
    }
    logger.info({ count: items.length }, 'Freelancer.com gigs fetched');
    return items;
  } catch (err) {
    logger.warn({ err }, 'findFreelancerGigs failed');
    return [];
  }
}

/** Aggregate all freelance gig sources (Reddit, Freelancer, Algora, GitHub, Huntr) */
export async function findFreelanceGigs(limit = 30): Promise<Bounty[]> {
  const [reddit, freelancer, algora, github] = await Promise.allSettled([
    findRedditGigs(limit),
    findFreelancerGigs(limit),
    findAlgoraBounties(limit),
    findGithubBounties(limit),
  ]);

  const huntr = getHuntrBountyInfo();

  const all: Bounty[] = [
    ...(reddit.status === 'fulfilled' ? reddit.value : []),
    ...(freelancer.status === 'fulfilled' ? freelancer.value : []),
    ...(algora.status === 'fulfilled' ? algora.value : []),
    ...(github.status === 'fulfilled' ? github.value : []),
    ...huntr,
  ];

  // Deduplicate by id
  const seen = new Set<string>();
  const deduped = all.filter(b => {
    if (seen.has(b.id)) return false;
    seen.add(b.id);
    return true;
  });

  // Sort by reward descending (null rewards go to the bottom)
  deduped.sort((a, b) => {
    if (a.reward_usd === null && b.reward_usd === null) return 0;
    if (a.reward_usd === null) return 1;
    if (b.reward_usd === null) return -1;
    return b.reward_usd - a.reward_usd;
  });

  return deduped.slice(0, limit);
}

/** Merge all bounty sources, sorted by reward (highest first) */
export async function findBounties(limit = 20): Promise<Bounty[]> {
  const [algora, github, bossdev] = await Promise.allSettled([
    findAlgoraBounties(limit),
    findGithubBounties(limit),
    findBossDevBounties(GITHUB_TOKEN || undefined, limit),
  ]);

  const huntr = getHuntrBountyInfo();

  const all: Bounty[] = [
    ...(algora.status === 'fulfilled' ? algora.value : []),
    ...(github.status === 'fulfilled' ? github.value : []),
    ...(bossdev.status === 'fulfilled' ? bossdev.value : []),
    ...huntr,
  ];

  // Deduplicate by id
  const seen = new Set<string>();
  const deduped = all.filter(b => {
    if (seen.has(b.id)) return false;
    seen.add(b.id);
    return true;
  });

  // Sort by reward descending (null rewards go to the bottom)
  deduped.sort((a, b) => {
    if (a.reward_usd === null && b.reward_usd === null) return 0;
    if (a.reward_usd === null) return 1;
    if (b.reward_usd === null) return -1;
    return b.reward_usd - a.reward_usd;
  });

  return deduped.slice(0, limit);
}
