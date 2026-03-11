/**
 * Workflow Executor
 * DAG executor with topological ordering (Kahn's algorithm), cycle detection,
 * and per-step error handling (retry, skip, fail, compensate).
 */
import crypto from 'node:crypto';
import type { GatewayManager } from '../gateway/manager';
import type {
  Workflow,
  WorkflowStep,
  WorkflowEdge,
  WorkflowInstance,
  TaskConfig,
  ConditionConfig,
  ParallelConfig,
  WaitConfig,
} from './workflow-types';
import { workflowStore } from './workflow-store';
import { evaluateExpression } from './expression-eval';
import { logger } from '../utils/logger';

const TASK_POLL_INTERVAL_MS = 3000;
const TASK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ---- Cycle detection & topological sort ----

/**
 * Topological sort using Kahn's algorithm.
 * Returns sorted step IDs or throws if a cycle is detected.
 */
function topologicalSort(steps: WorkflowStep[], edges: WorkflowEdge[]): string[] {
  const stepIds = steps.map((s) => s.id);
  // Build adjacency: from -> [to]
  const adj = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const id of stepIds) {
    adj.set(id, []);
    inDegree.set(id, 0);
  }

  for (const edge of edges) {
    if (edge.from === '__start__' || edge.to === '__end__') continue;
    if (!adj.has(edge.from) || !adj.has(edge.to)) continue;
    adj.get(edge.from)!.push(edge.to);
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  const queue = stepIds.filter((id) => (inDegree.get(id) ?? 0) === 0);
  const sorted: string[] = [];

  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);
    for (const neighbor of adj.get(node) ?? []) {
      const deg = (inDegree.get(neighbor) ?? 0) - 1;
      inDegree.set(neighbor, deg);
      if (deg === 0) queue.push(neighbor);
    }
  }

  if (sorted.length !== stepIds.length) {
    throw new Error('Workflow contains a cycle');
  }

  return sorted;
}

/**
 * Validate a workflow's DAG structure.
 * Throws if a cycle is detected.
 */
export function validateWorkflow(workflow: Workflow): void {
  topologicalSort(workflow.steps, workflow.edges);
}

// ---- Executor ----

export class WorkflowExecutor {
  private gatewayManager: GatewayManager | null = null;
  private runningInstances = new Map<string, AbortController>();

  init(gatewayManager: GatewayManager): void {
    this.gatewayManager = gatewayManager;
    logger.debug('[WorkflowExecutor] Initialized');
  }

  getRunningInstances(): string[] {
    return Array.from(this.runningInstances.keys());
  }

  async startWorkflow(workflowId: string): Promise<WorkflowInstance> {
    const workflow = await workflowStore.getWorkflow(workflowId);
    if (!workflow) throw new Error(`Workflow ${workflowId} not found`);
    if (!workflow.enabled) throw new Error(`Workflow ${workflowId} is disabled`);

    // Validate DAG
    validateWorkflow(workflow);

    const now = new Date().toISOString();
    const instance: WorkflowInstance = {
      id: crypto.randomUUID(),
      workflowId,
      status: 'running',
      stepStates: {},
      context: {},
      startedAt: now,
    };

    // Initialize all step states as pending
    for (const step of workflow.steps) {
      instance.stepStates[step.id] = {
        status: 'pending',
        retryCount: 0,
      };
    }

    await workflowStore.saveInstance(instance);

    const abort = new AbortController();
    this.runningInstances.set(instance.id, abort);

    // Run in background
    this._runWorkflow(workflow, instance, abort.signal).catch((err) => {
      logger.warn(`[WorkflowExecutor] Uncaught error in workflow ${workflowId}: ${String(err)}`);
    });

    return instance;
  }

  async cancelWorkflow(instanceId: string): Promise<void> {
    const abort = this.runningInstances.get(instanceId);
    if (!abort) throw new Error(`Instance ${instanceId} is not running`);
    abort.abort();

    const instance = await workflowStore.getInstance(instanceId);
    if (instance) {
      instance.status = 'cancelled';
      instance.completedAt = new Date().toISOString();
      await workflowStore.saveInstance(instance);
    }

    this.runningInstances.delete(instanceId);
    logger.debug(`[WorkflowExecutor] Cancelled instance ${instanceId}`);
  }

  // ---- Private execution logic ----

  private async _runWorkflow(
    workflow: Workflow,
    instance: WorkflowInstance,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const sorted = topologicalSort(workflow.steps, workflow.edges);
      const stepMap = new Map(workflow.steps.map((s) => [s.id, s]));

      for (const stepId of sorted) {
        if (signal.aborted) break;

        const step = stepMap.get(stepId)!;

        // Check if incoming condition edges are satisfied
        const incomingEdges = workflow.edges.filter(
          (e) => e.to === stepId && e.from !== '__start__',
        );
        let shouldRun = true;
        for (const edge of incomingEdges) {
          if (edge.condition) {
            const condResult = evaluateExpression(edge.condition, {
              ...instance.context,
              ...instance.stepStates,
            });
            if (!condResult) {
              shouldRun = false;
              break;
            }
          }
          // If a predecessor step failed/skipped, check if we can proceed
          if (edge.from !== '__start__') {
            const predState = instance.stepStates[edge.from];
            if (predState?.status === 'failed' && workflow.errorStrategy === 'fail-fast') {
              shouldRun = false;
              break;
            }
          }
        }

        if (!shouldRun) {
          instance.stepStates[stepId] = {
            status: 'skipped',
            retryCount: 0,
            completedAt: new Date().toISOString(),
          };
          await workflowStore.saveInstance(instance);
          continue;
        }

        await this._runStep(workflow, instance, step, signal);

        if (signal.aborted) break;

        // Check for fatal failure
        const state = instance.stepStates[stepId];
        if (state.status === 'failed' && workflow.errorStrategy === 'fail-fast') {
          instance.status = 'failed';
          instance.error = state.error;
          instance.completedAt = new Date().toISOString();
          await workflowStore.saveInstance(instance);
          this.runningInstances.delete(instance.id);
          return;
        }

        if (state.status === 'failed' && step.onError === 'compensate') {
          // Run compensators in reverse sorted order (up to current step)
          await this._runCompensation(workflow, instance, sorted, stepId, signal);
          instance.status = 'failed';
          instance.error = state.error;
          instance.completedAt = new Date().toISOString();
          await workflowStore.saveInstance(instance);
          this.runningInstances.delete(instance.id);
          return;
        }
      }

      if (!signal.aborted) {
        // Check if any step failed
        const hasFailed = Object.values(instance.stepStates).some((s) => s.status === 'failed');
        instance.status = hasFailed ? 'failed' : 'completed';
        instance.completedAt = new Date().toISOString();
        await workflowStore.saveInstance(instance);
      }
    } catch (err) {
      instance.status = 'failed';
      instance.error = String(err);
      instance.completedAt = new Date().toISOString();
      await workflowStore.saveInstance(instance);
    } finally {
      this.runningInstances.delete(instance.id);
    }
  }

  private async _runStep(
    workflow: Workflow,
    instance: WorkflowInstance,
    step: WorkflowStep,
    signal: AbortSignal,
  ): Promise<void> {
    const stateRef = instance.stepStates[step.id];
    stateRef.status = 'running';
    stateRef.startedAt = new Date().toISOString();
    await workflowStore.saveInstance(instance);

    const maxRetries = step.retryPolicy?.maxRetries ?? 0;
    const backoffMs = step.retryPolicy?.backoffMs ?? 1000;

    while (true) {
      if (signal.aborted) return;

      try {
        const output = await this._executeStep(workflow, instance, step, signal);
        stateRef.status = 'completed';
        stateRef.output = output;
        stateRef.completedAt = new Date().toISOString();
        // Merge output into context under step ID
        instance.context[step.id] = output;
        await workflowStore.saveInstance(instance);
        return;
      } catch (err) {
        if (signal.aborted) return;

        const errMsg = String(err);

        if (step.onError === 'retry' && stateRef.retryCount < maxRetries) {
          stateRef.retryCount++;
          const delay = backoffMs * Math.pow(2, stateRef.retryCount - 1);
          logger.debug(
            `[WorkflowExecutor] Retrying step ${step.id} (attempt ${stateRef.retryCount}/${maxRetries}) after ${delay}ms`,
          );
          await this._sleep(delay, signal);
          continue;
        }

        if (step.onError === 'skip') {
          stateRef.status = 'skipped';
          stateRef.completedAt = new Date().toISOString();
          stateRef.error = errMsg;
          await workflowStore.saveInstance(instance);
          return;
        }

        // fail or compensate — mark failed
        stateRef.status = 'failed';
        stateRef.error = errMsg;
        stateRef.completedAt = new Date().toISOString();
        await workflowStore.saveInstance(instance);
        return;
      }
    }
  }

  private async _executeStep(
    _workflow: Workflow,
    instance: WorkflowInstance,
    step: WorkflowStep,
    signal: AbortSignal,
  ): Promise<unknown> {
    switch (step.type) {
      case 'task':
        return this._executeTaskStep(step.config as TaskConfig, signal);

      case 'condition':
        return this._executeConditionStep(step.config as ConditionConfig, instance);

      case 'parallel':
        return this._executeParallelStep(_workflow, instance, step, signal);

      case 'wait':
        return this._executeWaitStep(step.config as WaitConfig, signal);

      default:
        throw new Error(`Unknown step type: ${(step as WorkflowStep).type}`);
    }
  }

  private async _executeTaskStep(config: TaskConfig, signal: AbortSignal): Promise<unknown> {
    if (!this.gatewayManager) throw new Error('GatewayManager not initialized');

    await this.gatewayManager.rpc('cron.run', { id: config.jobId, mode: 'force' });

    // Poll cron.runs for completion
    const startTime = Date.now();

    while (true) {
      if (signal.aborted) throw new Error('Cancelled');
      if (Date.now() - startTime > TASK_TIMEOUT_MS) {
        throw new Error(`Task ${config.jobId} timed out after 5 minutes`);
      }

      await this._sleep(TASK_POLL_INTERVAL_MS, signal);

      if (signal.aborted) throw new Error('Cancelled');

      try {
        const result = (await this.gatewayManager.rpc('cron.runs', {
          id: config.jobId,
          limit: 1,
          offset: 0,
        })) as { runs?: Array<{ status?: string; error?: string; completedAt?: string }> };

        const latestRun = result?.runs?.[0];
        if (!latestRun) continue;

        if (latestRun.status === 'ok') {
          return latestRun;
        }
        if (latestRun.status === 'error') {
          throw new Error(latestRun.error ?? `Task ${config.jobId} failed`);
        }
        // Still running — continue polling
      } catch (err) {
        // Re-throw actual errors, not polling errors
        const msg = String(err);
        if (msg.includes('timed out') || msg.includes('Cancelled')) throw err;
        // Network/RPC errors during poll — retry after interval
      }
    }
  }

  private _executeConditionStep(
    config: ConditionConfig,
    instance: WorkflowInstance,
  ): Promise<boolean> {
    const result = evaluateExpression(config.expression, {
      ...instance.context,
      ...instance.stepStates,
    });
    return Promise.resolve(result);
  }

  private async _executeParallelStep(
    workflow: Workflow,
    instance: WorkflowInstance,
    parallelStep: WorkflowStep,
    signal: AbortSignal,
  ): Promise<unknown[]> {
    const config = parallelStep.config as ParallelConfig;

    // Child steps are those with an edge from this parallel step
    const childEdges = workflow.edges.filter((e) => e.from === parallelStep.id);
    const childStepIds = childEdges
      .map((e) => e.to)
      .filter((id) => id !== '__end__');
    const stepMap = new Map(workflow.steps.map((s) => [s.id, s]));

    const childPromises = childStepIds
      .map((id) => stepMap.get(id))
      .filter((s): s is WorkflowStep => s != null)
      .map((childStep) => this._runStep(workflow, instance, childStep, signal));

    if (config.join === 'all') {
      await Promise.all(childPromises);
    } else {
      await Promise.race(childPromises);
    }

    return childStepIds.map((id) => instance.stepStates[id]?.output);
  }

  private _executeWaitStep(config: WaitConfig, signal: AbortSignal): Promise<void> {
    return this._sleep(config.delayMs, signal);
  }

  private async _runCompensation(
    workflow: Workflow,
    instance: WorkflowInstance,
    sortedIds: string[],
    failedStepId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const stepMap = new Map(workflow.steps.map((s) => [s.id, s]));
    const failedIndex = sortedIds.indexOf(failedStepId);
    // Run compensators in reverse order for completed steps before the failed one
    const toCompensate = sortedIds.slice(0, failedIndex).reverse();

    for (const stepId of toCompensate) {
      if (signal.aborted) break;
      const step = stepMap.get(stepId);
      if (!step?.compensateJobId) continue;
      if (!this.gatewayManager) continue;

      try {
        await this.gatewayManager.rpc('cron.run', {
          id: step.compensateJobId,
          mode: 'force',
        });
        logger.debug(`[WorkflowExecutor] Compensation ran for step ${stepId}`);
      } catch (err) {
        logger.warn(
          `[WorkflowExecutor] Compensation failed for step ${stepId}: ${String(err)}`,
        );
      }
    }
  }

  private _sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('Cancelled'));
        return;
      }
      const timer = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('Cancelled'));
      });
    });
  }
}

export const workflowExecutor = new WorkflowExecutor();
