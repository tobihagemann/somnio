/** Resolves after `ms`, or immediately (with `false`) once `signal` aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * The shared periodic-loop skeleton for the tick services: sleeps for `intervalMs` between
 * passes and runs `body` each wake; an abort during the sleep ends the loop cleanly. Work that
 * must follow the last pass (a final save) goes after the returned promise.
 */
export async function runPeriodically(intervalMs: number, signal: AbortSignal, body: () => Promise<void>): Promise<void> {
  while (await sleep(intervalMs, signal)) {
    await body();
  }
}
