/**
 * Copyright (c) 2026 Vitor Faustino
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Recognized automation only. This is a metric filter, never a redirect gate.
 * Keep patterns specific: false positives would undercount legitimate visitors.
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
  
  // Known automation frameworks and generic crawler identifiers
  /headlesschrome|phantomjs|zombie\.js|capybara|scraper|spider|crawler|\bbot\b|monitoring/i,
];

/**
 * Purpose headers are tokenized and may be composed, for example
 * `Sec-Purpose: prefetch;prerender`. Match tokens instead of the raw literal
 * so compound values are still recognized as non-navigational.
 */
const PREFETCH_PURPOSES = new Set(["prefetch", "prerender"]);

function hasPrefetchPurpose(request: Request): boolean {
  return (
    hasPrefetchPurposeValue(request.headers.get('purpose')) ||
    hasPrefetchPurposeValue(request.headers.get('sec-purpose')) ||
    hasPrefetchPurposeValue(request.headers.get('x-purpose'))
  );
}

function hasPrefetchPurposeValue(value: string | null): boolean {
  if (!value) {
    return false;
  }

  for (const directive of value.toLowerCase().split(/[;,]/)) {
    const token = directive.split('=')[0]?.trim();
    if (token && PREFETCH_PURPOSES.has(token)) {
      return true;
    }
  }

  return false;
}

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
    if (hasPrefetchPurpose(request)) {
      return false;
    }

    // 3. Inspect the User-Agent before accepting navigation headers. Known
    // crawlers can send Sec-Fetch-Mode: navigate and must not inflate metrics.
    const userAgent = request.headers.get('user-agent');

    // Empty User-Agent is suspicious (bots often omit this)
    if (!userAgent || userAgent.trim() === '') {
      return false;
    }

    // 4. Check against known bot patterns
    if (BOT_PATTERNS.some((pattern) => pattern.test(userAgent))) {
      return false;
    }

    // 5. A browser navigation with a non-bot user agent is countable.
    const secFetchMode = request.headers.get('sec-fetch-mode');
    if (secFetchMode === 'navigate') {
      return true;
    }

    // 6. If Sec-Fetch-Mode is missing but User-Agent passed the specific bot
    // checks, keep the existing compatibility behavior for older browsers.
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

  if (hasPrefetchPurpose(request)) {
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
