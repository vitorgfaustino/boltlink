/**
 * Click Filter Module
 * Determines if a redirect should be counted as a legitimate user click
 * Filters out bots, crawlers, prefetch, prerender, and non-human traffic
 * 
 * BoltLink v1.1.0 — Phase 1: Real Click Filtering
 * AGPL-3.0 License — https://github.com/vitorgfaustino/boltlink
 */

/**
 * Comprehensive list of bot user agents and patterns to filter
 * Updated semi-frequently; consider making this externally configurable for future iterations
 */
const BOT_PATTERNS = [
  // Search engine bots
  /googlebot|google-structured-data-testing-tool|adsbot-google|apis-google|mediapartners-google/i,
  
  // Social media bots
  /facebookexternalhit|facebot|twitterbot|linkedinbot|pinterestbot|whatsapp|telegram|discordbot|slackbot/i,
  
  // Other major crawlers
  /applebot|bingbot|bingpreview|duckduckbot|yandexbot|baiduspider|sogoubot|janrain/i,
  
  // Uptime monitors and health check bots
  /uptimerobot|pingdom|statuscake|betteruptime|freshping|sitepulse|updown|mon\.itor\.us|monitis/i,
  
  // SEO and analysis bots
  /ahrefs|semrushbot|majestic|dotbot|mj12bot|ahrefsbot|seobility|okhttpbot/i,
  
  // CLI tools and programmatic access
  /curl|wget|httpie|python-requests|go-http-client|java|perl|ruby|scala|php/i,
  
  // Content monitoring and scraping
  /scrapy|mechanize|beautifulsoup|netscape|libwww-perl|w3m|elinks|links|lynx/i,
  
  // Other suspicious patterns
  /headless|phantom|zombie|capybara|selector|splitter|parser|spider|crawler|bot|monitoring/i,
];

/**
 * Checks if a request represents a legitimate user click
 * Uses short-circuit logic: returns false on first match, true only if all checks pass
 * 
 * Order of checks is optimized for performance (cheapest checks first):
 * 1. HTTP method (in-memory, O(1))
 * 2. Purpose headers (in-memory, O(1))
 * 3. User-Agent checks (in-memory, O(n) but fast string ops)
 * 4. Sec-Fetch-Mode (in-memory, O(1))
 * 5. Conservative fallback
 */
export function isCountableClick(request: Request): boolean {
  try {
    // 1. Only GET requests should be counted
    // HEAD, OPTIONS, POST, etc. are not clicks
    if (request.method !== 'GET') {
      return false;
    }

    // 2. Check for explicit prefetch/prerender headers (short-circuit if present)
    // These indicate the browser/platform is not navigating, just prefetching
    const purpose = request.headers.get('purpose');
    if (purpose === 'prefetch' || purpose === 'prerender') {
      return false;
    }

    const secPurpose = request.headers.get('sec-purpose');
    if (secPurpose === 'prefetch' || secPurpose === 'prerender') {
      return false;
    }

    const xPurpose = request.headers.get('x-purpose');
    if (xPurpose === 'prefetch' || xPurpose === 'prerender') {
      return false;
    }

    // 3. Check Sec-Fetch-Mode: if it's a navigation, it's a real click
    // "navigate" = user is actively navigating
    const secFetchMode = request.headers.get('sec-fetch-mode');
    if (secFetchMode === 'navigate') {
      return true;
    }

    // 4. Get User-Agent for further analysis
    const userAgent = request.headers.get('user-agent');

    // Empty User-Agent is suspicious (bots often omit this)
    if (!userAgent || userAgent.trim() === '') {
      return false;
    }

    // 5. Check against known bot patterns
    if (BOT_PATTERNS.some((pattern) => pattern.test(userAgent))) {
      return false;
    }

    // 6. If Sec-Fetch-Mode is missing but User-Agent looks like a browser, likely legitimate
    // Most browsers send Sec-Fetch-Mode, but some clients/older browsers might not
    // If we have a UA and it's not a bot, assume it's legitimate
    if (!secFetchMode) {
      // Conservative approach: if we don't have Sec-Fetch-Mode and UA passed bot check,
      // trust it (most modern browsers send this, and older browsers are still legitimate users)
      return true;
    }

    // 7. Default: if we reach here and don't know, be conservative and reject
    // This handles edge cases we haven't accounted for
    return false;
  } catch (error) {
    // On any parsing error, be conservative and reject the click
    console.warn('[click-filter] Error during click validation:', error);
    return false;
  }
}

/**
 * Export list of bot patterns for testing and documentation purposes
 */
export const getBotPatternsList = (): RegExp[] => BOT_PATTERNS;

/**
 * Allows counting successful password-gate submissions as clicks.
 * This keeps bot filtering while supporting links protected by password.
 */
export function isCountablePasswordSubmission(request: Request): boolean {
  if (request.method !== 'POST') {
    return false;
  }

  const purpose = request.headers.get('purpose');
  const secPurpose = request.headers.get('sec-purpose');
  const xPurpose = request.headers.get('x-purpose');
  if (purpose === 'prefetch' || purpose === 'prerender' || secPurpose === 'prefetch' || secPurpose === 'prerender' || xPurpose === 'prefetch' || xPurpose === 'prerender') {
    return false;
  }

  const userAgent = request.headers.get('user-agent');
  if (!userAgent || userAgent.trim() === '') {
    return false;
  }

  if (BOT_PATTERNS.some((pattern) => pattern.test(userAgent))) {
    return false;
  }

  return true;
}

/**
 * Utility function to check if a specific User-Agent is recognized as a bot
 * Useful for logging and debugging
 */
export function identifyBot(userAgent: string): string | null {
  for (const pattern of BOT_PATTERNS) {
    const match = userAgent.match(pattern);
    if (match) {
      return match[0];
    }
  }
  return null;
}
