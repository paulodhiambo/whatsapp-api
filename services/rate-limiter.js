"use strict";

/**
 * Simple in-memory sliding-window rate limiter keyed by wa_id.
 * Each instance has its own bucket — spawn one per gateway process.
 */

const DEFAULT_WINDOW_MS  = 60_000;   // 1 minute
const DEFAULT_MAX_REQS   = 30;

module.exports = class RateLimiter {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.windowMs]  - Time window in milliseconds.
   * @param {number} [opts.maxRequests] - Maximum requests per window.
   */
  constructor(opts = {}) {
    this.windowMs    = opts.windowMs    ?? DEFAULT_WINDOW_MS;
    this.maxRequests = opts.maxRequests ?? DEFAULT_MAX_REQS;
    /** @type {Map<string, { count: number, resetAt: number }>} */
    this._buckets = new Map();
  }

  /**
   * Check and record a request for `key`.
   * Returns `true` if within limit, `false` if rate-limited.
   * @param {string} key - Usually wa_id.
   * @returns {boolean}
   */
  check(key) {
    const now = Date.now();
    let b = this._buckets.get(key);

    if (!b || now > b.resetAt) {
      b = { count: 0, resetAt: now + this.windowMs };
    }

    b.count++;
    this._buckets.set(key, b);

    const allowed = b.count <= this.maxRequests;

    // Lazy-evict old entries every 100 checks
    if (this._buckets.size > this.maxRequests * 10) {
      this._evict(now);
    }

    return allowed;
  }

  /**
   * Reset the count for a specific key (e.g. on successful action).
   * @param {string} key
   */
  reset(key) {
    this._buckets.delete(key);
  }

  /** Clear all buckets (e.g. on test teardown). */
  clear() {
    this._buckets.clear();
  }

  /** @private */
  _evict(now) {
    for (const [k, b] of this._buckets) {
      if (now > b.resetAt) this._buckets.delete(k);
    }
  }
};
