/**
 * Unit tests for event trigger matching logic in TriggerManager
 * Source: electron/automation/trigger-manager.ts
 *
 * The matching logic lives in the private methods _handleGatewayNotification and
 * _handleJobCompletion. We test it by wiring up a TriggerManager instance with the
 * automationEventBus and observing whether _executeJob fires (mocked via gatewayManager).
 *
 * Note: TriggerManager uses electron-store for persistence; we mock it out.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---- Mock electron-store before importing TriggerManager ----
vi.mock('electron-store', () => {
  const data: Record<string, unknown> = {};
  return {
    default: class MockStore {
      get(key: string) {
        return data[key] ?? undefined;
      }
      set(key: string, value: unknown) {
        data[key] = value;
      }
    },
  };
});

// ---- Mock file-watcher to avoid fs operations ----
vi.mock('@electron/automation/file-watcher', () => ({
  fileWatcher: {
    addWatch: vi.fn(),
    removeWatch: vi.fn(),
    destroy: vi.fn(),
  },
}));

// ---- Mock logger ----
vi.mock('@electron/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { TriggerManager } from '@electron/automation/trigger-manager';
import { automationEventBus } from '@electron/automation/event-bus';
import type { EventTrigger } from '@electron/automation/types';

// ---- Helper: create a minimal EventTrigger ----

function makeTrigger(overrides: Partial<EventTrigger> = {}): EventTrigger {
  return {
    id: 'trigger-1',
    jobId: 'job-1',
    source: 'gateway',
    filter: {},
    debounceMs: 0,
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---- Helper: build a mock gateway manager ----

function mockGatewayManager() {
  return {
    rpc: vi.fn().mockResolvedValue({}),
  };
}

describe('TriggerManager — gateway:notification matching', () => {
  let manager: TriggerManager;
  let gw: ReturnType<typeof mockGatewayManager>;

  beforeEach(() => {
    vi.useFakeTimers();
    automationEventBus.removeAllListeners();
    manager = new TriggerManager();
    gw = mockGatewayManager();
    // Inject gateway directly (init() needs store, we bypass it)
    // @ts-expect-error — accessing private field for test setup
    manager.gatewayManager = gw;
  });

  afterEach(() => {
    automationEventBus.removeAllListeners();
    vi.useRealTimers();
  });

  it('fires when no filter (matches anything)', () => {
    const trigger = makeTrigger({ filter: {}, debounceMs: 0 });
    // @ts-expect-error — call private method directly
    manager._registerListener(trigger);

    automationEventBus.emit('gateway:notification', {
      notification: { jsonrpc: '2.0', method: 'chat.message_received', params: {} },
    });

    expect(gw.rpc).toHaveBeenCalledWith('cron.run', { id: 'job-1', mode: 'force' });
  });

  it('fires when eventType matches', () => {
    const trigger = makeTrigger({ filter: { eventType: 'chat.message_received' }, debounceMs: 0 });
    // @ts-expect-error -- accessing private method for test
    manager._registerListener(trigger);

    automationEventBus.emit('gateway:notification', {
      notification: { jsonrpc: '2.0', method: 'chat.message_received', params: {} },
    });

    expect(gw.rpc).toHaveBeenCalledTimes(1);
  });

  it('does not fire when eventType does not match', () => {
    const trigger = makeTrigger({ filter: { eventType: 'chat.message_received' }, debounceMs: 0 });
    // @ts-expect-error -- accessing private method for test
    manager._registerListener(trigger);

    automationEventBus.emit('gateway:notification', {
      notification: { jsonrpc: '2.0', method: 'tool.call_started', params: {} },
    });

    expect(gw.rpc).not.toHaveBeenCalled();
  });

  it('fires when channelId filter matches', () => {
    const trigger = makeTrigger({ filter: { channelId: 'ch-42' }, debounceMs: 0 });
    // @ts-expect-error -- accessing private method for test
    manager._registerListener(trigger);

    automationEventBus.emit('gateway:notification', {
      notification: {
        jsonrpc: '2.0',
        method: 'chat.message_received',
        params: { channelId: 'ch-42' },
      },
    });

    expect(gw.rpc).toHaveBeenCalledTimes(1);
  });

  it('does not fire when channelId filter mismatches', () => {
    const trigger = makeTrigger({ filter: { channelId: 'ch-42' }, debounceMs: 0 });
    // @ts-expect-error -- accessing private method for test
    manager._registerListener(trigger);

    automationEventBus.emit('gateway:notification', {
      notification: {
        jsonrpc: '2.0',
        method: 'chat.message_received',
        params: { channelId: 'ch-99' },
      },
    });

    expect(gw.rpc).not.toHaveBeenCalled();
  });

  it('fires when regex pattern matches stringified params', () => {
    const trigger = makeTrigger({ filter: { pattern: 'urgent' }, debounceMs: 0 });
    // @ts-expect-error -- accessing private method for test
    manager._registerListener(trigger);

    automationEventBus.emit('gateway:notification', {
      notification: {
        jsonrpc: '2.0',
        method: 'chat.message_received',
        params: { text: 'this is urgent!' },
      },
    });

    expect(gw.rpc).toHaveBeenCalledTimes(1);
  });

  it('does not fire when regex pattern does not match', () => {
    const trigger = makeTrigger({ filter: { pattern: 'urgent' }, debounceMs: 0 });
    // @ts-expect-error -- accessing private method for test
    manager._registerListener(trigger);

    automationEventBus.emit('gateway:notification', {
      notification: {
        jsonrpc: '2.0',
        method: 'chat.message_received',
        params: { text: 'routine message' },
      },
    });

    expect(gw.rpc).not.toHaveBeenCalled();
  });

  it('handles invalid regex pattern gracefully (does not throw, falls through to fire)', () => {
    const trigger = makeTrigger({ filter: { pattern: '[invalid regex' }, debounceMs: 0 });
    // @ts-expect-error -- accessing private method for test
    manager._registerListener(trigger);

    // Should not throw even with invalid regex
    expect(() => {
      automationEventBus.emit('gateway:notification', {
        notification: { jsonrpc: '2.0', method: 'chat.message_received', params: {} },
      });
    }).not.toThrow();

    // The catch block falls through (does not return early), so _fireTrigger is still called
    expect(gw.rpc).toHaveBeenCalledTimes(1);
  });

  it('applies combined eventType + channelId filters (AND semantics)', () => {
    const trigger = makeTrigger({
      filter: { eventType: 'chat.message_received', channelId: 'ch-1' },
      debounceMs: 0,
    });
    // @ts-expect-error -- accessing private method for test
    manager._registerListener(trigger);

    // Correct eventType but wrong channelId → no fire
    automationEventBus.emit('gateway:notification', {
      notification: {
        jsonrpc: '2.0',
        method: 'chat.message_received',
        params: { channelId: 'ch-99' },
      },
    });
    expect(gw.rpc).not.toHaveBeenCalled();

    // Correct eventType and correct channelId → fire
    automationEventBus.emit('gateway:notification', {
      notification: {
        jsonrpc: '2.0',
        method: 'chat.message_received',
        params: { channelId: 'ch-1' },
      },
    });
    expect(gw.rpc).toHaveBeenCalledTimes(1);
  });
});

describe('TriggerManager — job:completion matching', () => {
  let manager: TriggerManager;
  let gw: ReturnType<typeof mockGatewayManager>;

  beforeEach(() => {
    vi.useFakeTimers();
    automationEventBus.removeAllListeners();
    manager = new TriggerManager();
    gw = mockGatewayManager();
    // @ts-expect-error -- accessing private method for test
    manager.gatewayManager = gw;
  });

  afterEach(() => {
    automationEventBus.removeAllListeners();
    vi.useRealTimers();
  });

  it('fires for any job completion when no filter set', () => {
    const trigger = makeTrigger({ source: 'job_completion', filter: {}, debounceMs: 0 });
    // @ts-expect-error -- accessing private method for test
    manager._registerListener(trigger);

    automationEventBus.emit('job:completion', { jobId: 'any-job', status: 'ok', ts: Date.now() });
    expect(gw.rpc).toHaveBeenCalledTimes(1);
  });

  it('fires only for specified jobId', () => {
    const trigger = makeTrigger({
      source: 'job_completion',
      filter: { jobId: 'target-job' },
      debounceMs: 0,
    });
    // @ts-expect-error -- accessing private method for test
    manager._registerListener(trigger);

    // Wrong job
    automationEventBus.emit('job:completion', {
      jobId: 'other-job',
      status: 'ok',
      ts: Date.now(),
    });
    expect(gw.rpc).not.toHaveBeenCalled();

    // Correct job
    automationEventBus.emit('job:completion', {
      jobId: 'target-job',
      status: 'ok',
      ts: Date.now(),
    });
    expect(gw.rpc).toHaveBeenCalledTimes(1);
  });

  it('fires only when status matches statusMatch filter', () => {
    const trigger = makeTrigger({
      source: 'job_completion',
      filter: { statusMatch: 'error' },
      debounceMs: 0,
    });
    // @ts-expect-error -- accessing private method for test
    manager._registerListener(trigger);

    // ok status should not fire
    automationEventBus.emit('job:completion', { jobId: 'job-1', status: 'ok', ts: Date.now() });
    expect(gw.rpc).not.toHaveBeenCalled();

    // error status should fire
    automationEventBus.emit('job:completion', { jobId: 'job-1', status: 'error', ts: Date.now() });
    expect(gw.rpc).toHaveBeenCalledTimes(1);
  });

  it('statusMatch "any" matches all statuses', () => {
    const trigger = makeTrigger({
      source: 'job_completion',
      filter: { statusMatch: 'any' },
      debounceMs: 0,
    });
    // @ts-expect-error -- accessing private method for test
    manager._registerListener(trigger);

    automationEventBus.emit('job:completion', { jobId: 'job-1', status: 'ok', ts: Date.now() });
    automationEventBus.emit('job:completion', { jobId: 'job-1', status: 'error', ts: Date.now() });
    expect(gw.rpc).toHaveBeenCalledTimes(2);
  });
});

describe('TriggerManager — debounce', () => {
  let manager: TriggerManager;
  let gw: ReturnType<typeof mockGatewayManager>;

  beforeEach(() => {
    vi.useFakeTimers();
    automationEventBus.removeAllListeners();
    manager = new TriggerManager();
    gw = mockGatewayManager();
    // @ts-expect-error -- accessing private method for test
    manager.gatewayManager = gw;
  });

  afterEach(() => {
    automationEventBus.removeAllListeners();
    vi.useRealTimers();
  });

  it('debounces multiple rapid events into one execution', () => {
    const trigger = makeTrigger({ filter: {}, debounceMs: 500 });
    // @ts-expect-error -- accessing private method for test
    manager._registerListener(trigger);

    // Fire 3 times rapidly
    automationEventBus.emit('gateway:notification', {
      notification: { jsonrpc: '2.0', method: 'ping', params: {} },
    });
    automationEventBus.emit('gateway:notification', {
      notification: { jsonrpc: '2.0', method: 'ping', params: {} },
    });
    automationEventBus.emit('gateway:notification', {
      notification: { jsonrpc: '2.0', method: 'ping', params: {} },
    });

    // Before debounce timer fires — no execution yet
    expect(gw.rpc).not.toHaveBeenCalled();

    // After debounce period — exactly one execution
    vi.advanceTimersByTime(600);
    expect(gw.rpc).toHaveBeenCalledTimes(1);
  });
});
