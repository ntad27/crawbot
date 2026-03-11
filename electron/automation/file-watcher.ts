/**
 * File Watcher
 * Watches file system paths for changes and emits to AutomationEventBus
 */
import { watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, normalize } from 'node:path';
import { automationEventBus } from './event-bus';
import { logger } from '../utils/logger';

interface WatchEntry {
  path: string;
  triggerId: string;
  watcher: FSWatcher;
}

export class FileWatcher {
  private watches = new Map<string, WatchEntry>();

  /**
   * Add a file or directory watch for a trigger.
   * Security: only paths under the user's home directory are allowed.
   */
  addWatch(filePath: string, triggerId: string): void {
    // Security: resolve and normalize the path
    const resolved = normalize(resolve(filePath));
    const home = normalize(homedir());

    if (!resolved.startsWith(home)) {
      logger.warn(`[FileWatcher] Rejected watch outside home dir: ${resolved}`);
      return;
    }

    // Remove existing watch for this trigger if any
    this.removeWatch(triggerId);

    try {
      const watcher = watch(resolved, { persistent: false }, (eventType, _filename) => {
        automationEventBus.emitFileChange({
          path: resolved,
          triggerId,
          eventType: eventType === 'rename' ? 'rename' : 'change',
        });
      });

      watcher.on('error', (err) => {
        logger.warn(`[FileWatcher] Watch error for ${resolved}: ${err.message}`);
        this.removeWatch(triggerId);
      });

      this.watches.set(triggerId, { path: resolved, triggerId, watcher });
      logger.debug(`[FileWatcher] Watching ${resolved} for trigger ${triggerId}`);
    } catch (err) {
      logger.warn(`[FileWatcher] Failed to watch ${resolved}: ${String(err)}`);
    }
  }

  /**
   * Remove the watch for a specific trigger.
   */
  removeWatch(triggerId: string): void {
    const entry = this.watches.get(triggerId);
    if (entry) {
      try {
        entry.watcher.close();
      } catch {
        // ignore close errors
      }
      this.watches.delete(triggerId);
      logger.debug(`[FileWatcher] Removed watch for trigger ${triggerId}`);
    }
  }

  /**
   * Close all watchers.
   */
  destroy(): void {
    for (const [triggerId] of this.watches) {
      this.removeWatch(triggerId);
    }
  }
}

export const fileWatcher = new FileWatcher();
