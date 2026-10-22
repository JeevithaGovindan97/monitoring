export type SiteState = 'up' | 'down' | 'degraded' | 'unknown';

export interface Counters {
  state: SiteState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
}
export interface Step extends Counters {
  event: 'outage_opened' | 'recovered' | null;
}

/**
 * Pure state machine.
 *  - An outage opens after `failThreshold` consecutive failures (default 2).
 *  - It recovers after `recoverThreshold` consecutive successes (default 2).
 *  - Until a threshold is crossed the previous state is retained (a single failure never flips a site to down).
 *  - A successful but slow response (> degraded threshold) marks the site "degraded".
 */
export function step(cur: Counters, success: boolean, slow: boolean, failThreshold: number, recoverThreshold: number): Step {
  const failures = success ? 0 : cur.consecutiveFailures + 1;
  const successes = success ? cur.consecutiveSuccesses + 1 : 0;
  let state = cur.state;
  let event: Step['event'] = null;
  if (cur.state === 'down') {
    if (successes >= recoverThreshold) {
      state = slow ? 'degraded' : 'up';
      event = 'recovered';
    }
  } else if (failures >= failThreshold) {
    state = 'down';
    event = 'outage_opened';
  } else if (success) {
    state = slow ? 'degraded' : 'up';
  }
  return { state, consecutiveFailures: failures, consecutiveSuccesses: successes, event };
}
