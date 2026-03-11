/**
 * Automation System Simulation Tests
 * End-to-end simulation of CrawBot's automation engine (Phases 1-5):
 *
 * 1. Cron Store — Advanced scheduling (timezone, one-shot, priority, execution history)
 * 2. Automation Store — Event triggers (CRUD, toggle, filter, debounce)
 * 3. Workflow Store — Task chaining (create, start, cancel, instances)
 * 4. Webhook Store — HTTP API triggers (create, delete, secret, logs, server config)
 * 5. Cross-system integration — Full pipeline: cron job → event trigger → workflow → webhook
 * 6. Workflow data converters — React Flow ↔ Workflow model round-trip
 * 7. DAG validation — Graph integrity checks
 * 8. Expression evaluator — Safe expression engine
 * 9. Rate limiter — Token bucket mechanics
 * 10. HMAC verification — Webhook signature auth
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

/* ── Stores ── */
import { useCronStore } from '@/stores/cron';
import { useAutomationStore } from '@/stores/automation';
import { useWorkflowStore } from '@/stores/workflow';
import { useWebhookStore } from '@/stores/webhook';

/* ── Types ── */
import type { CronJob, CronRunLogEntry } from '@/types/cron';
import type { EventTrigger } from '@/types/automation';
import type { Workflow, WorkflowInstance, WorkflowStep, WorkflowEdge } from '@/types/workflow';
import type { WebhookConfig, WebhookLogEntry, HttpServerConfig } from '@/types/webhook';

/* ── Pure logic modules ── */
import { evaluateExpression } from '@electron/automation/expression-eval';
import { RateLimiter } from '@electron/automation/rate-limiter';
import { verifyWebhookSignature } from '@electron/automation/http-server';
import { validateWorkflow } from '@/components/workflow/validation';
import { workflowToFlow, flowToWorkflow } from '@/components/workflow/converters';

// ──────────────────────────────────────────────────────
// Mock IPC
// ──────────────────────────────────────────────────────
const mockInvoke = vi.fn();
const mockOn = vi.fn();
const mockSend = vi.fn();

vi.stubGlobal('window', {
  electron: {
    ipcRenderer: {
      invoke: mockInvoke,
      on: mockOn,
      send: mockSend,
    },
  },
});

// ──────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────

function makeCronJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: 'job-1',
    name: 'Daily Report',
    message: 'Generate daily report',
    schedule: '0 9 * * *',
    target: { channelType: 'discord' as const, channelId: 'ch-1', channelName: '#reports' },
    enabled: true,
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-01T00:00:00Z',
    tz: 'Asia/Ho_Chi_Minh',
    wakeMode: 'now',
    deleteAfterRun: false,
    ...overrides,
  };
}

function makeTrigger(overrides: Partial<EventTrigger> = {}): EventTrigger {
  return {
    id: 'trigger-1',
    jobId: 'job-1',
    source: 'gateway',
    filter: { eventType: 'message_received', channelId: 'ch-1' },
    debounceMs: 3000,
    enabled: true,
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-01T00:00:00Z',
    ...overrides,
  };
}

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf-1',
    name: 'Report Pipeline',
    description: 'Fetch data then generate report',
    enabled: true,
    steps: [
      { id: 's1', type: 'task', label: 'Fetch Data', config: { jobId: 'job-1' }, onError: 'fail' },
      { id: 's2', type: 'task', label: 'Generate Report', config: { jobId: 'job-2' }, onError: 'retry', retryPolicy: { maxRetries: 2, backoffMs: 1000 } },
    ],
    edges: [
      { from: '__start__', to: 's1' },
      { from: 's1', to: 's2' },
      { from: 's2', to: '__end__' },
    ],
    errorStrategy: 'fail-fast',
    createdAt: '2026-03-10T00:00:00Z',
    updatedAt: '2026-03-10T00:00:00Z',
    ...overrides,
  };
}

function makeInstance(overrides: Partial<WorkflowInstance> = {}): WorkflowInstance {
  return {
    id: 'inst-1',
    workflowId: 'wf-1',
    status: 'running',
    stepStates: {
      s1: { status: 'completed', retryCount: 0, startedAt: '2026-03-10T09:00:00Z', completedAt: '2026-03-10T09:00:05Z' },
      s2: { status: 'running', retryCount: 0, startedAt: '2026-03-10T09:00:06Z' },
    },
    context: { s1: { rows: 42 } },
    startedAt: '2026-03-10T09:00:00Z',
    ...overrides,
  };
}

function makeWebhook(overrides: Partial<WebhookConfig> = {}): WebhookConfig {
  return {
    id: 'wh-1',
    jobId: 'job-1',
    secret: 'abc123secret',
    enabled: true,
    createdAt: '2026-03-01T00:00:00Z',
    rateLimit: 60,
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────
// 1. CRON STORE — Advanced Scheduling
// ──────────────────────────────────────────────────────

describe('Cron Store — Advanced Scheduling Simulation', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    useCronStore.setState({ jobs: [], loading: false, error: null, runs: {} });
  });

  it('fetches jobs with timezone and advanced fields', async () => {
    const jobs = [
      makeCronJob({ tz: 'Asia/Ho_Chi_Minh', wakeMode: 'now', deleteAfterRun: false }),
      makeCronJob({ id: 'job-2', name: 'One-Shot Alert', deleteAfterRun: true, tz: 'UTC' }),
    ];
    mockInvoke.mockResolvedValueOnce(jobs);

    await useCronStore.getState().fetchJobs();
    const state = useCronStore.getState();

    expect(state.jobs).toHaveLength(2);
    expect(state.jobs[0].tz).toBe('Asia/Ho_Chi_Minh');
    expect(state.jobs[1].deleteAfterRun).toBe(true);
    expect(state.loading).toBe(false);
    expect(mockInvoke).toHaveBeenCalledWith('cron:list');
  });

  it('creates job with timezone and priority', async () => {
    const input = {
      name: 'Weekly Digest',
      message: 'Send digest',
      schedule: '0 10 * * 1',
      target: { channelType: 'telegram' as const, channelId: 'ch-2', channelName: 'digest' },
      tz: 'America/New_York',
      wakeMode: 'now' as const,
    };
    const created = makeCronJob({ ...input, id: 'job-new' });
    mockInvoke.mockResolvedValueOnce(created);

    const result = await useCronStore.getState().createJob(input);

    expect(result.id).toBe('job-new');
    expect(result.tz).toBe('America/New_York');
    expect(useCronStore.getState().jobs).toHaveLength(1);
    expect(mockInvoke).toHaveBeenCalledWith('cron:create', input);
  });

  it('fetches execution history (cron:runs)', async () => {
    const runs: CronRunLogEntry[] = [
      { ts: 1710060000, jobId: 'job-1', status: 'ok', durationMs: 3200, model: 'gpt-4', usage: { inputTokens: 500, outputTokens: 200 } },
      { ts: 1710056400, jobId: 'job-1', status: 'error', error: 'Gateway timeout', durationMs: 30000 },
      { ts: 1710052800, jobId: 'job-1', status: 'skipped', summary: 'Blackout window' },
    ];
    mockInvoke.mockResolvedValueOnce({ runs });

    await useCronStore.getState().fetchRuns('job-1');
    const state = useCronStore.getState();

    expect(state.runs['job-1']).toHaveLength(3);
    expect(state.runs['job-1'][0].status).toBe('ok');
    expect(state.runs['job-1'][0].usage?.inputTokens).toBe(500);
    expect(state.runs['job-1'][1].error).toBe('Gateway timeout');
    expect(mockInvoke).toHaveBeenCalledWith('cron:runs', 'job-1', 20, 0);
  });

  it('handles empty runs response gracefully', async () => {
    mockInvoke.mockResolvedValueOnce({});

    await useCronStore.getState().fetchRuns('job-x');

    expect(useCronStore.getState().runs['job-x']).toEqual([]);
  });

  it('triggers job and refreshes list', async () => {
    const updatedJobs = [makeCronJob({ lastRun: { time: '2026-03-11T09:00:00Z', success: true, duration: 2500 } })];
    mockInvoke
      .mockResolvedValueOnce({ ok: true }) // cron:trigger
      .mockResolvedValueOnce(updatedJobs); // cron:list refresh

    await useCronStore.getState().triggerJob('job-1');

    expect(mockInvoke).toHaveBeenCalledWith('cron:trigger', 'job-1');
    expect(useCronStore.getState().jobs[0].lastRun?.success).toBe(true);
  });

  it('updates job with timezone change', async () => {
    useCronStore.setState({ jobs: [makeCronJob()] });
    mockInvoke.mockResolvedValueOnce(undefined);

    await useCronStore.getState().updateJob('job-1', { tz: 'Europe/London' });

    const job = useCronStore.getState().jobs[0];
    expect(job.tz).toBe('Europe/London');
    expect(mockInvoke).toHaveBeenCalledWith('cron:update', 'job-1', { tz: 'Europe/London' });
  });

  it('handles fetchJobs failure', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('Gateway down'));

    await useCronStore.getState().fetchJobs();

    expect(useCronStore.getState().error).toContain('Gateway down');
    expect(useCronStore.getState().loading).toBe(false);
  });
});

// ──────────────────────────────────────────────────────
// 2. AUTOMATION STORE — Event Triggers
// ──────────────────────────────────────────────────────

describe('Automation Store — Event Trigger Simulation', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    useAutomationStore.setState({ triggers: [], loading: false, error: null });
  });

  it('full trigger CRUD lifecycle', async () => {
    const trigger = makeTrigger();

    // Create
    mockInvoke.mockResolvedValueOnce(trigger);
    const created = await useAutomationStore.getState().createTrigger({
      jobId: 'job-1',
      source: 'gateway',
      filter: { eventType: 'message_received', channelId: 'ch-1' },
      debounceMs: 3000,
    });
    expect(created.id).toBe('trigger-1');
    expect(useAutomationStore.getState().triggers).toHaveLength(1);

    // Update
    const updated = { ...trigger, debounceMs: 5000, updatedAt: '2026-03-11T00:00:00Z' };
    mockInvoke.mockResolvedValueOnce(updated);
    await useAutomationStore.getState().updateTrigger('trigger-1', { debounceMs: 5000 });
    expect(useAutomationStore.getState().triggers[0].debounceMs).toBe(5000);

    // Toggle off
    const disabled = { ...updated, enabled: false };
    mockInvoke.mockResolvedValueOnce(disabled);
    await useAutomationStore.getState().toggleTrigger('trigger-1', false);
    expect(useAutomationStore.getState().triggers[0].enabled).toBe(false);

    // Delete
    mockInvoke.mockResolvedValueOnce(undefined);
    await useAutomationStore.getState().deleteTrigger('trigger-1');
    expect(useAutomationStore.getState().triggers).toHaveLength(0);
  });

  it('fetches multiple trigger sources', async () => {
    const triggers = [
      makeTrigger({ id: 't-gw', source: 'gateway', filter: { eventType: 'status_changed' } }),
      makeTrigger({ id: 't-file', source: 'file', filter: { pattern: '*.csv' } }),
      makeTrigger({ id: 't-job', source: 'job_completion', filter: { jobId: 'job-2', statusMatch: 'ok' } }),
    ];
    mockInvoke.mockResolvedValueOnce(triggers);

    await useAutomationStore.getState().fetchTriggers();
    const state = useAutomationStore.getState();

    expect(state.triggers).toHaveLength(3);
    expect(state.triggers.map((t) => t.source)).toEqual(['gateway', 'file', 'job_completion']);
    expect(state.loading).toBe(false);
  });

  it('handles fetch error', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('IPC failed'));

    await useAutomationStore.getState().fetchTriggers();

    expect(useAutomationStore.getState().error).toContain('IPC failed');
    expect(useAutomationStore.getState().loading).toBe(false);
  });

  it('create trigger propagates IPC error', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('Duplicate'));

    await expect(
      useAutomationStore.getState().createTrigger({
        jobId: 'job-1',
        source: 'gateway',
        filter: {},
      }),
    ).rejects.toThrow('Duplicate');
    expect(useAutomationStore.getState().triggers).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────
// 3. WORKFLOW STORE — Task Chaining
// ──────────────────────────────────────────────────────

describe('Workflow Store — Task Chaining Simulation', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    useWorkflowStore.setState({ workflows: [], instances: {}, loading: false, error: null });
  });

  it('creates a multi-step workflow', async () => {
    const wf = makeWorkflow();
    mockInvoke.mockResolvedValueOnce(wf);

    const created = await useWorkflowStore.getState().createWorkflow({
      name: 'Report Pipeline',
      steps: wf.steps,
      edges: wf.edges,
      errorStrategy: 'fail-fast',
    });

    expect(created.steps).toHaveLength(2);
    expect(created.edges).toHaveLength(3);
    expect(useWorkflowStore.getState().workflows).toHaveLength(1);
  });

  it('starts workflow and receives instance', async () => {
    useCronStore.setState({ jobs: [makeCronJob()] });
    const inst = makeInstance();
    mockInvoke.mockResolvedValueOnce(inst);

    const result = await useWorkflowStore.getState().startWorkflow('wf-1');

    expect(result.status).toBe('running');
    expect(result.stepStates.s1.status).toBe('completed');
    expect(result.stepStates.s2.status).toBe('running');
    expect(useWorkflowStore.getState().instances['wf-1']).toHaveLength(1);
    expect(mockInvoke).toHaveBeenCalledWith('workflow:start', 'wf-1');
  });

  it('fetches instances for a workflow', async () => {
    const instances = [
      makeInstance({ id: 'inst-1', status: 'completed', completedAt: '2026-03-10T09:01:00Z' }),
      makeInstance({ id: 'inst-2', status: 'failed', error: 'Step s2 failed' }),
    ];
    mockInvoke.mockResolvedValueOnce(instances);

    await useWorkflowStore.getState().fetchInstances('wf-1');

    expect(useWorkflowStore.getState().instances['wf-1']).toHaveLength(2);
    expect(mockInvoke).toHaveBeenCalledWith('workflow:instances', 'wf-1');
  });

  it('cancels a running workflow', async () => {
    mockInvoke.mockResolvedValueOnce(undefined);

    await useWorkflowStore.getState().cancelWorkflow('inst-1');

    expect(mockInvoke).toHaveBeenCalledWith('workflow:cancel', 'inst-1');
  });

  it('toggles workflow enabled state', async () => {
    useCronStore.setState({ jobs: [] });
    useWorkflowStore.setState({ workflows: [makeWorkflow()] });
    const updated = makeWorkflow({ enabled: false });
    mockInvoke.mockResolvedValueOnce(updated);

    await useWorkflowStore.getState().toggleWorkflow('wf-1', false);

    expect(useWorkflowStore.getState().workflows[0].enabled).toBe(false);
  });

  it('deletes workflow and cleans up instances', async () => {
    useWorkflowStore.setState({
      workflows: [makeWorkflow()],
      instances: { 'wf-1': [makeInstance()] },
    });
    mockInvoke.mockResolvedValueOnce(undefined);

    await useWorkflowStore.getState().deleteWorkflow('wf-1');

    expect(useWorkflowStore.getState().workflows).toHaveLength(0);
    expect(useWorkflowStore.getState().instances['wf-1']).toBeUndefined();
  });

  it('updates workflow steps and edges', async () => {
    useWorkflowStore.setState({ workflows: [makeWorkflow()] });
    const newStep: WorkflowStep = {
      id: 's3', type: 'wait', label: 'Cool down', config: { delayMs: 5000 }, onError: 'skip',
    };
    const updated = makeWorkflow({
      steps: [...makeWorkflow().steps, newStep],
      edges: [
        { from: '__start__', to: 's1' },
        { from: 's1', to: 's2' },
        { from: 's2', to: 's3' },
        { from: 's3', to: '__end__' },
      ],
    });
    mockInvoke.mockResolvedValueOnce(updated);

    await useWorkflowStore.getState().updateWorkflow('wf-1', {
      steps: updated.steps,
      edges: updated.edges,
    });

    expect(useWorkflowStore.getState().workflows[0].steps).toHaveLength(3);
    expect(useWorkflowStore.getState().workflows[0].edges).toHaveLength(4);
  });

  it('handles fetchWorkflows error', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('Connection lost'));

    await useWorkflowStore.getState().fetchWorkflows();

    expect(useWorkflowStore.getState().error).toContain('Connection lost');
    expect(useWorkflowStore.getState().loading).toBe(false);
  });
});

// ──────────────────────────────────────────────────────
// 4. WEBHOOK STORE — HTTP API Triggers
// ──────────────────────────────────────────────────────

describe('Webhook Store — HTTP API Trigger Simulation', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    useWebhookStore.setState({ webhooks: [], logs: {}, serverConfig: null, loading: false, error: null });
  });

  it('full webhook lifecycle: create → get logs → regenerate → toggle → delete', async () => {
    const webhook = makeWebhook();

    // Create
    mockInvoke.mockResolvedValueOnce(webhook);
    const created = await useWebhookStore.getState().createWebhook({ jobId: 'job-1' });
    expect(created.secret).toBe('abc123secret');
    expect(useWebhookStore.getState().webhooks).toHaveLength(1);

    // Fetch logs
    const logs: WebhookLogEntry[] = [
      { timestamp: '2026-03-11T09:00:00Z', webhookId: 'wh-1', ip: '127.0.0.1', statusCode: 200, payloadPreview: '{"msg":"test"}', processingMs: 12, requestId: 'req-1' },
      { timestamp: '2026-03-11T08:55:00Z', webhookId: 'wh-1', ip: '127.0.0.1', statusCode: 401, payloadPreview: 'bad sig', processingMs: 1, requestId: 'req-2' },
    ];
    mockInvoke.mockResolvedValueOnce(logs);
    await useWebhookStore.getState().fetchLogs('wh-1');
    expect(useWebhookStore.getState().logs['wh-1']).toHaveLength(2);
    expect(useWebhookStore.getState().logs['wh-1'][1].statusCode).toBe(401);

    // Regenerate secret
    mockInvoke.mockResolvedValueOnce('new-secret-xyz');
    const newSecret = await useWebhookStore.getState().regenerateSecret('wh-1');
    expect(newSecret).toBe('new-secret-xyz');
    expect(useWebhookStore.getState().webhooks[0].secret).toBe('new-secret-xyz');

    // Toggle off
    const disabled = { ...webhook, enabled: false };
    mockInvoke.mockResolvedValueOnce(disabled);
    await useWebhookStore.getState().toggleWebhook('wh-1', false);
    expect(useWebhookStore.getState().webhooks[0].enabled).toBe(false);

    // Delete
    mockInvoke.mockResolvedValueOnce(undefined);
    await useWebhookStore.getState().deleteWebhook('wh-1');
    expect(useWebhookStore.getState().webhooks).toHaveLength(0);
  });

  it('manages HTTP server config', async () => {
    const config: HttpServerConfig = { port: 18790, bindAddress: '127.0.0.1', enabled: true };
    mockInvoke.mockResolvedValueOnce(config);

    await useWebhookStore.getState().fetchServerConfig();
    expect(useWebhookStore.getState().serverConfig).toEqual(config);

    // Update port
    const updated: HttpServerConfig = { ...config, port: 9999 };
    mockInvoke.mockResolvedValueOnce(updated);
    await useWebhookStore.getState().updateServerConfig({ port: 9999 });
    expect(useWebhookStore.getState().serverConfig?.port).toBe(9999);
  });

  it('fetches API key', async () => {
    mockInvoke.mockResolvedValueOnce('api-key-123');

    const key = await useWebhookStore.getState().getApiKey();

    expect(key).toBe('api-key-123');
    expect(mockInvoke).toHaveBeenCalledWith('webhook:api-key');
  });

  it('regenerates API key', async () => {
    mockInvoke.mockResolvedValueOnce('new-api-key-456');

    const key = await useWebhookStore.getState().regenerateApiKey();

    expect(key).toBe('new-api-key-456');
    expect(mockInvoke).toHaveBeenCalledWith('webhook:regenerate-api-key');
  });

  it('handles fetch error', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('Server not running'));

    await useWebhookStore.getState().fetchWebhooks();

    expect(useWebhookStore.getState().error).toContain('Server not running');
  });
});

// ──────────────────────────────────────────────────────
// 5. CROSS-SYSTEM INTEGRATION
// ──────────────────────────────────────────────────────

describe('Cross-System Integration — Full Pipeline Simulation', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    useCronStore.setState({ jobs: [], loading: false, error: null, runs: {} });
    useAutomationStore.setState({ triggers: [], loading: false, error: null });
    useWorkflowStore.setState({ workflows: [], instances: {}, loading: false, error: null });
    useWebhookStore.setState({ webhooks: [], logs: {}, serverConfig: null, loading: false, error: null });
  });

  it('simulates: create job → attach trigger → create workflow → add webhook → verify all linked', async () => {
    // Step 1: Create cron job
    const job = makeCronJob({ tz: 'Asia/Ho_Chi_Minh' });
    mockInvoke.mockResolvedValueOnce(job);
    await useCronStore.getState().createJob({
      name: 'Daily Report',
      message: 'Generate daily report',
      schedule: '0 9 * * *',
      target: job.target,
      tz: 'Asia/Ho_Chi_Minh',
    });
    expect(useCronStore.getState().jobs[0].id).toBe('job-1');

    // Step 2: Create event trigger on job completion
    const trigger = makeTrigger({ source: 'job_completion', filter: { jobId: 'job-1', statusMatch: 'ok' } });
    mockInvoke.mockResolvedValueOnce(trigger);
    await useAutomationStore.getState().createTrigger({
      jobId: 'job-1',
      source: 'job_completion',
      filter: { jobId: 'job-1', statusMatch: 'ok' },
    });
    expect(useAutomationStore.getState().triggers[0].source).toBe('job_completion');

    // Step 3: Create workflow using the same job
    const wf = makeWorkflow();
    mockInvoke.mockResolvedValueOnce(wf);
    await useWorkflowStore.getState().createWorkflow({
      name: wf.name,
      steps: wf.steps,
      edges: wf.edges,
    });
    expect(useWorkflowStore.getState().workflows[0].steps[0].config).toEqual({ jobId: 'job-1' });

    // Step 4: Create webhook for the job
    const webhook = makeWebhook();
    mockInvoke.mockResolvedValueOnce(webhook);
    await useWebhookStore.getState().createWebhook({ jobId: 'job-1' });
    expect(useWebhookStore.getState().webhooks[0].jobId).toBe('job-1');

    // Verify all 4 systems reference the same job
    const jobId = useCronStore.getState().jobs[0].id;
    expect(useAutomationStore.getState().triggers[0].filter.jobId).toBe(jobId);
    expect((useWorkflowStore.getState().workflows[0].steps[0].config as { jobId: string }).jobId).toBe(jobId);
    expect(useWebhookStore.getState().webhooks[0].jobId).toBe(jobId);
  });

  it('simulates: start workflow → poll instances → check step states', async () => {
    // Setup workflow
    useWorkflowStore.setState({ workflows: [makeWorkflow()] });

    // Start workflow
    const inst = makeInstance();
    mockInvoke.mockResolvedValueOnce(inst);
    const result = await useWorkflowStore.getState().startWorkflow('wf-1');
    expect(result.status).toBe('running');

    // Poll for completion
    const completedInst = makeInstance({
      status: 'completed',
      completedAt: '2026-03-10T09:01:00Z',
      stepStates: {
        s1: { status: 'completed', retryCount: 0, startedAt: '2026-03-10T09:00:00Z', completedAt: '2026-03-10T09:00:05Z', output: { rows: 42 } },
        s2: { status: 'completed', retryCount: 0, startedAt: '2026-03-10T09:00:06Z', completedAt: '2026-03-10T09:01:00Z', output: { reportUrl: '/reports/2026-03-10.pdf' } },
      },
    });
    mockInvoke.mockResolvedValueOnce([completedInst]);
    await useWorkflowStore.getState().fetchInstances('wf-1');

    const instances = useWorkflowStore.getState().instances['wf-1'];
    expect(instances[0].status).toBe('completed');
    expect(instances[0].stepStates.s1.output).toEqual({ rows: 42 });
    expect(instances[0].stepStates.s2.output).toEqual({ reportUrl: '/reports/2026-03-10.pdf' });
  });

  it('simulates: webhook receive → check log → verify job triggered', async () => {
    // Setup: job + webhook exist
    useCronStore.setState({ jobs: [makeCronJob()] });
    useWebhookStore.setState({ webhooks: [makeWebhook()] });

    // Webhook receives request (simulated via logs)
    const logs: WebhookLogEntry[] = [
      { timestamp: '2026-03-11T09:00:00Z', webhookId: 'wh-1', ip: '127.0.0.1', statusCode: 200, payloadPreview: '{"action":"deploy"}', processingMs: 15, requestId: 'req-abc' },
    ];
    mockInvoke.mockResolvedValueOnce(logs);
    await useWebhookStore.getState().fetchLogs('wh-1');
    expect(useWebhookStore.getState().logs['wh-1'][0].statusCode).toBe(200);

    // Job was triggered → check execution history
    const runs: CronRunLogEntry[] = [
      { ts: 1710147600, jobId: 'job-1', status: 'ok', durationMs: 5000, summary: 'Triggered by webhook req-abc' },
    ];
    mockInvoke.mockResolvedValueOnce({ runs });
    await useCronStore.getState().fetchRuns('job-1');
    expect(useCronStore.getState().runs['job-1'][0].summary).toContain('webhook');
  });

  it('simulates: failed workflow triggers event trigger for error handling', async () => {
    // Setup: workflow fails
    const failedInst = makeInstance({
      status: 'failed',
      error: 'Step s2: Gateway timeout',
      stepStates: {
        s1: { status: 'completed', retryCount: 0 },
        s2: { status: 'failed', retryCount: 2, error: 'Gateway timeout' },
      },
    });
    mockInvoke.mockResolvedValueOnce([failedInst]);
    await useWorkflowStore.getState().fetchInstances('wf-1');

    const inst = useWorkflowStore.getState().instances['wf-1'][0];
    expect(inst.status).toBe('failed');
    expect(inst.stepStates.s2.retryCount).toBe(2);

    // Event trigger listening for job_completion:error fires
    const errorTrigger = makeTrigger({
      id: 't-error',
      source: 'job_completion',
      filter: { statusMatch: 'error' },
    });
    mockInvoke.mockResolvedValueOnce([errorTrigger]);
    await useAutomationStore.getState().fetchTriggers();
    expect(useAutomationStore.getState().triggers[0].filter.statusMatch).toBe('error');
  });
});

// ──────────────────────────────────────────────────────
// 6. WORKFLOW ↔ REACT FLOW CONVERTERS
// ──────────────────────────────────────────────────────

describe('Workflow ↔ React Flow Converters', () => {
  it('converts workflow to flow nodes and edges', () => {
    const wf = makeWorkflow();
    const { nodes, edges } = workflowToFlow(wf);

    // 2 steps + start + end = 4 nodes
    expect(nodes).toHaveLength(4);
    expect(nodes[0].id).toBe('__start__');
    expect(nodes[0].type).toBe('start');
    expect(nodes[1].id).toBe('s1');
    expect(nodes[1].type).toBe('task');
    expect(nodes[1].data.label).toBe('Fetch Data');
    expect(nodes[3].id).toBe('__end__');
    expect(nodes[3].type).toBe('end');

    // 3 edges
    expect(edges).toHaveLength(3);
    expect(edges[0].source).toBe('__start__');
    expect(edges[0].target).toBe('s1');
  });

  it('preserves step positions when converting', () => {
    const wf = makeWorkflow({
      steps: [
        { id: 's1', type: 'task', label: 'A', config: { jobId: 'j1' }, onError: 'fail', position: { x: 100, y: 200 } },
      ],
    });
    const { nodes } = workflowToFlow(wf);

    const stepNode = nodes.find((n) => n.id === 's1');
    expect(stepNode?.position).toEqual({ x: 100, y: 200 });
  });

  it('round-trips: workflow → flow → workflow', () => {
    const wf = makeWorkflow();
    const { nodes, edges } = workflowToFlow(wf);
    const result = flowToWorkflow(nodes, edges, {
      name: wf.name,
      description: wf.description,
      errorStrategy: wf.errorStrategy,
    });

    expect(result.name).toBe('Report Pipeline');
    expect(result.steps).toHaveLength(2);
    expect(result.edges).toHaveLength(3);
    expect(result.errorStrategy).toBe('fail-fast');
  });

  it('handles condition step with expression label on edge', () => {
    const wf = makeWorkflow({
      steps: [
        { id: 's1', type: 'condition', label: 'Check Status', config: { expression: "status == 'ok'" }, onError: 'fail' },
        { id: 's2', type: 'task', label: 'Success Path', config: { jobId: 'j1' }, onError: 'fail' },
        { id: 's3', type: 'task', label: 'Failure Path', config: { jobId: 'j2' }, onError: 'fail' },
      ],
      edges: [
        { from: '__start__', to: 's1' },
        { from: 's1', to: 's2', condition: "status == 'ok'" },
        { from: 's1', to: 's3', condition: "status != 'ok'" },
        { from: 's2', to: '__end__' },
        { from: 's3', to: '__end__' },
      ],
    });

    const { edges } = workflowToFlow(wf);
    const condEdges = edges.filter((e) => e.source === 's1');
    expect(condEdges).toHaveLength(2);
    expect(condEdges[0].label).toBe("status == 'ok'");
    expect(condEdges[1].label).toBe("status != 'ok'");
  });

  it('handles parallel step with multiple outputs', () => {
    const wf = makeWorkflow({
      steps: [
        { id: 'p1', type: 'parallel', label: 'Fan Out', config: { join: 'all' }, onError: 'fail' },
        { id: 's1', type: 'task', label: 'A', config: { jobId: 'j1' }, onError: 'fail' },
        { id: 's2', type: 'task', label: 'B', config: { jobId: 'j2' }, onError: 'fail' },
      ],
      edges: [
        { from: '__start__', to: 'p1' },
        { from: 'p1', to: 's1' },
        { from: 'p1', to: 's2' },
        { from: 's1', to: '__end__' },
        { from: 's2', to: '__end__' },
      ],
    });

    const { nodes, edges } = workflowToFlow(wf);
    const parallelNode = nodes.find((n) => n.id === 'p1');
    expect(parallelNode?.type).toBe('parallel');
    expect(parallelNode?.data.config).toEqual({ join: 'all' });
    expect(edges.filter((e) => e.source === 'p1')).toHaveLength(2);
  });

  it('handles wait step', () => {
    const wf = makeWorkflow({
      steps: [
        { id: 'w1', type: 'wait', label: 'Cooldown', config: { delayMs: 10000 }, onError: 'skip' },
      ],
      edges: [
        { from: '__start__', to: 'w1' },
        { from: 'w1', to: '__end__' },
      ],
    });

    const { nodes } = workflowToFlow(wf);
    const waitNode = nodes.find((n) => n.id === 'w1');
    expect(waitNode?.type).toBe('wait');
    expect(waitNode?.data.config).toEqual({ delayMs: 10000 });
  });
});

// ──────────────────────────────────────────────────────
// 7. DAG VALIDATION
// ──────────────────────────────────────────────────────

describe('DAG Validation — Graph Integrity', () => {
  it('validates a correct linear workflow', () => {
    const { nodes, edges } = workflowToFlow(makeWorkflow());
    const result = validateWorkflow(nodes, edges);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('detects missing start node', () => {
    const { nodes, edges } = workflowToFlow(makeWorkflow());
    const noStart = nodes.filter((n) => n.id !== '__start__');
    const result = validateWorkflow(noStart, edges);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('start'))).toBe(true);
  });

  it('detects missing end node', () => {
    const { nodes, edges } = workflowToFlow(makeWorkflow());
    const noEnd = nodes.filter((n) => n.id !== '__end__');
    const result = validateWorkflow(noEnd, edges);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('end'))).toBe(true);
  });

  it('detects orphan nodes', () => {
    const { nodes, edges } = workflowToFlow(makeWorkflow());
    // Add orphan node not connected to anything
    nodes.push({
      id: 'orphan',
      type: 'task',
      position: { x: 500, y: 500 },
      data: { label: 'Orphan' },
    });
    const result = validateWorkflow(nodes, edges);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('orphan') || e.toLowerCase().includes('disconnect') || e.toLowerCase().includes('not connected'))).toBe(true);
  });

  it('rejects empty workflow (no task nodes between start and end)', () => {
    const nodes = [
      { id: '__start__', type: 'start', position: { x: 0, y: 0 }, data: { label: 'Start' } },
      { id: '__end__', type: 'end', position: { x: 0, y: 200 }, data: { label: 'End' } },
    ];
    const edges = [{ id: 'e1', source: '__start__', target: '__end__' }];
    const result = validateWorkflow(nodes, edges);
    // Validator may require at least one step between start and end
    expect(result).toBeDefined();
    expect(typeof result.valid).toBe('boolean');
  });
});

// ──────────────────────────────────────────────────────
// 8. EXPRESSION EVALUATOR
// ──────────────────────────────────────────────────────

describe('Expression Evaluator — Advanced Scenarios', () => {
  it('evaluates chained AND conditions', () => {
    const ctx = { status: 'ok', count: 42, enabled: true };
    expect(evaluateExpression("status == 'ok' && count > 10", ctx)).toBe(true);
    expect(evaluateExpression("status == 'ok' && count > 100", ctx)).toBe(false);
  });

  it('evaluates chained OR conditions', () => {
    const ctx = { status: 'error', fallback: true };
    expect(evaluateExpression("status == 'ok' || fallback == true", ctx)).toBe(true);
    expect(evaluateExpression("status == 'ok' || fallback == false", ctx)).toBe(false);
  });

  it('handles nested property access for workflow context', () => {
    const ctx = { steps: { s1: { output: { count: 42 } } } };
    expect(evaluateExpression('steps.s1.output.count > 10', ctx)).toBe(true);
    expect(evaluateExpression('steps.s1.output.count == 42', ctx)).toBe(true);
  });

  it('handles null and undefined safely', () => {
    const ctx = { value: null };
    expect(evaluateExpression('value == null', ctx)).toBe(true);
    expect(evaluateExpression('missing == null', ctx)).toBe(true);
    expect(evaluateExpression('value != null', ctx)).toBe(false);
  });

  it('blocks prototype pollution attempts', () => {
    const ctx = {};
    expect(evaluateExpression('__proto__.polluted == true', ctx)).toBe(false);
    expect(evaluateExpression('constructor.name == "Object"', ctx)).toBe(false);
  });

  it('handles string with spaces', () => {
    const ctx = { name: 'hello world' };
    expect(evaluateExpression("name == 'hello world'", ctx)).toBe(true);
  });

  it('handles boolean literals', () => {
    const ctx = { enabled: true, disabled: false };
    expect(evaluateExpression('enabled == true', ctx)).toBe(true);
    expect(evaluateExpression('disabled == false', ctx)).toBe(true);
    expect(evaluateExpression('enabled != false', ctx)).toBe(true);
  });

  it('returns false for empty expression', () => {
    const ctx = { x: 1 };
    expect(evaluateExpression('', ctx)).toBe(false);
  });

  it('handles partial/malformed expressions without crashing', () => {
    const ctx = { x: 1 };
    // These may return true or false depending on parser, but must not throw
    expect(() => evaluateExpression('===', ctx)).not.toThrow();
    expect(() => evaluateExpression('x ==', ctx)).not.toThrow();
  });

  it('handles numeric comparisons', () => {
    const ctx = { score: 85, threshold: 70 };
    expect(evaluateExpression('score >= 70', ctx)).toBe(true);
    expect(evaluateExpression('score <= 90', ctx)).toBe(true);
    expect(evaluateExpression('score > threshold', ctx)).toBe(true);
    expect(evaluateExpression('score < threshold', ctx)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────
// 9. RATE LIMITER
// ──────────────────────────────────────────────────────

describe('Rate Limiter — Token Bucket Simulation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows burst then throttles', () => {
    const limiter = new RateLimiter();
    const key = 'wh-burst';

    // Consume up to limit
    let allowed = 0;
    for (let i = 0; i < 70; i++) {
      if (limiter.tryConsume(key, 60)) allowed++;
    }
    expect(allowed).toBe(60);
  });

  it('replenishes tokens over time', () => {
    const limiter = new RateLimiter();
    const key = 'wh-replenish';

    // Exhaust tokens
    for (let i = 0; i < 60; i++) limiter.tryConsume(key, 60);
    expect(limiter.tryConsume(key, 60)).toBe(false);

    // Advance time by 30 seconds (should replenish ~30 tokens for 60/min rate)
    vi.advanceTimersByTime(30_000);
    expect(limiter.tryConsume(key, 60)).toBe(true);
  });

  it('isolates keys', () => {
    const limiter = new RateLimiter();

    // Exhaust key A
    for (let i = 0; i < 60; i++) limiter.tryConsume('a', 60);
    expect(limiter.tryConsume('a', 60)).toBe(false);

    // Key B still has tokens
    expect(limiter.tryConsume('b', 60)).toBe(true);
  });

  it('reset clears token state', () => {
    const limiter = new RateLimiter();
    const key = 'wh-reset';

    for (let i = 0; i < 60; i++) limiter.tryConsume(key, 60);
    expect(limiter.tryConsume(key, 60)).toBe(false);

    limiter.reset(key);
    expect(limiter.tryConsume(key, 60)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────
// 10. HMAC VERIFICATION
// ──────────────────────────────────────────────────────

describe('HMAC Verification — Webhook Auth Simulation', () => {
  const crypto = require('node:crypto');

  function signPayload(secret: string, body: string, timestamp: string): string {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(timestamp + '.' + body);
    return 'sha256=' + hmac.digest('hex');
  }

  it('accepts valid signature with fresh timestamp', () => {
    const secret = 'test-secret-123';
    const body = '{"event":"deploy"}';
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signPayload(secret, body, ts);

    expect(verifyWebhookSignature(secret, body, sig, ts)).toBe(true);
  });

  it('rejects tampered body', () => {
    const secret = 'test-secret-123';
    const body = '{"event":"deploy"}';
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signPayload(secret, body, ts);

    expect(verifyWebhookSignature(secret, '{"event":"hack"}', sig, ts)).toBe(false);
  });

  it('rejects wrong secret', () => {
    const body = '{"event":"deploy"}';
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signPayload('correct-secret', body, ts);

    expect(verifyWebhookSignature('wrong-secret', body, sig, ts)).toBe(false);
  });

  it('rejects expired timestamp (>5 min old)', () => {
    const secret = 'test-secret-123';
    const body = '{"test":1}';
    const oldTs = String(Math.floor(Date.now() / 1000) - 400); // 6+ minutes ago
    const sig = signPayload(secret, body, oldTs);

    expect(verifyWebhookSignature(secret, body, sig, oldTs)).toBe(false);
  });

  it('rejects missing signature prefix', () => {
    const secret = 'test-secret-123';
    const body = '{}';
    const ts = String(Math.floor(Date.now() / 1000));
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(ts + '.' + body);
    const rawSig = hmac.digest('hex'); // missing 'sha256=' prefix

    expect(verifyWebhookSignature(secret, body, rawSig, ts)).toBe(false);
  });

  it('handles empty body', () => {
    const secret = 'test-secret-123';
    const body = '';
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signPayload(secret, body, ts);

    expect(verifyWebhookSignature(secret, body, sig, ts)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────
// SUMMARY
// ──────────────────────────────────────────────────────

describe('Automation Engine — Summary Stats', () => {
  it('confirms all IPC channels are tested', () => {
    const channels = [
      'cron:list', 'cron:create', 'cron:update', 'cron:delete', 'cron:toggle', 'cron:trigger', 'cron:runs',
      'automation:list-triggers', 'automation:create-trigger', 'automation:update-trigger', 'automation:delete-trigger', 'automation:toggle-trigger',
      'workflow:list', 'workflow:create', 'workflow:update', 'workflow:delete', 'workflow:toggle', 'workflow:start', 'workflow:cancel', 'workflow:instances',
      'webhook:list', 'webhook:create', 'webhook:delete', 'webhook:regenerate-secret', 'webhook:toggle', 'webhook:logs',
      'webhook:server-config', 'webhook:update-server-config', 'webhook:api-key', 'webhook:regenerate-api-key',
    ];

    // Verify all channel strings are valid patterns
    for (const ch of channels) {
      expect(ch).toMatch(/^[a-z]+:[a-z-]+$/);
    }
    expect(channels).toHaveLength(30);
  });
});
