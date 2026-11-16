import { onTestFinished } from 'vitest';

/**
 * Hides or shows the tab as the browser does: `visibilityState` changes, then `visibilitychange`
 * fires. The property is redefined on the shared `document`, so a hidden tab is shown again once the
 * test that hid it has finished, failed or not, unless the test showed it again first.
 */
export function tabTo(state: 'hidden' | 'visible'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
  if (state === 'hidden') onTestFinished(() => (document.visibilityState === 'hidden' ? tabTo('visible') : undefined));
}
