/**
 * CDP Focus Monitor
 *
 * Connects to Electron's browser-level CDP WebSocket as a second client
 * to monitor Target.activateTarget commands from Playwright/OpenClaw.
 * When detected, syncs the active tab in CrawBot's UI.
 *
 * Browser-level CDP allows multiple clients (unlike page-level).
 */

import { automationViews } from './automation-views';
import { logger } from '../utils/logger';

const LOG_TAG = '[CDP-FocusMonitor]';

let pollInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start monitoring for tab focus changes.
 *
 * Since Playwright's Page.bringToFront doesn't trigger detectable Electron events,
 * we poll each WebContentsView's page-level CDP to detect which page last received
 * a bringToFront command by checking Runtime.evaluate on a focus flag.
 */
export async function startCdpFocusMonitor(_cdpPort = 9222): Promise<void> {
  // Poll webContents.isFocused() to detect Playwright's bringToFront
  pollInterval = setInterval(() => {
    const tabs = automationViews.getAllTabs();
    for (const tab of tabs) {
      try {
        if (tab.view.webContents.isFocused() && automationViews.getActiveTabId() !== tab.id) {
          logger.info(`${LOG_TAG} Tab ${tab.id} isFocused, activating`);
          automationViews.setActiveTab(tab.id);
          automationViews.notifyRendererPublic('browser:tab:activated', tab.id);
          break; // Only one tab can be focused
        }
      } catch { /* */ }
    }
  }, 300);

  logger.info(`${LOG_TAG} Focus polling started (300ms interval)`);
}

export function stopCdpFocusMonitor(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}
