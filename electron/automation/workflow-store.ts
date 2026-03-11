/**
 * Workflow Store (Persistence)
 * CRUD for Workflow definitions and WorkflowInstance records
 * Uses electron-store for persistence (same pattern as trigger-manager.ts)
 */
import type { Workflow, WorkflowInstance } from './workflow-types';
import { logger } from '../utils/logger';

const MAX_INSTANCES = 100;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let storeInstance: any = null;

async function getStore() {
  if (!storeInstance) {
    const Store = (await import('electron-store')).default;
    storeInstance = new Store({ name: 'workflows' });
  }
  return storeInstance;
}

export class WorkflowStore {
  // ---- Workflow CRUD ----

  async listWorkflows(): Promise<Workflow[]> {
    const store = await getStore();
    return (store.get('automation.workflows') as Workflow[]) ?? [];
  }

  async getWorkflow(id: string): Promise<Workflow | undefined> {
    const workflows = await this.listWorkflows();
    return workflows.find((w) => w.id === id);
  }

  async saveWorkflow(workflow: Workflow): Promise<void> {
    const store = await getStore();
    const workflows = await this.listWorkflows();
    const index = workflows.findIndex((w) => w.id === workflow.id);

    if (index === -1) {
      workflows.push(workflow);
    } else {
      workflows[index] = workflow;
    }

    store.set('automation.workflows', workflows);
    logger.debug(`[WorkflowStore] Saved workflow ${workflow.id}`);
  }

  async deleteWorkflow(id: string): Promise<void> {
    const store = await getStore();
    const workflows = await this.listWorkflows();
    const filtered = workflows.filter((w) => w.id !== id);
    store.set('automation.workflows', filtered);

    // Also remove all instances for this workflow
    const instances = await this.listInstances();
    const filteredInstances = instances.filter((i) => i.workflowId !== id);
    store.set('automation.instances', filteredInstances);

    logger.debug(`[WorkflowStore] Deleted workflow ${id}`);
  }

  // ---- WorkflowInstance CRUD ----

  async listInstances(workflowId?: string): Promise<WorkflowInstance[]> {
    const store = await getStore();
    const all = (store.get('automation.instances') as WorkflowInstance[]) ?? [];
    if (workflowId) {
      return all.filter((i) => i.workflowId === workflowId);
    }
    return all;
  }

  async getInstance(id: string): Promise<WorkflowInstance | undefined> {
    const instances = await this.listInstances();
    return instances.find((i) => i.id === id);
  }

  async saveInstance(instance: WorkflowInstance): Promise<void> {
    const store = await getStore();
    const instances = await this.listInstances();
    const index = instances.findIndex((i) => i.id === instance.id);

    if (index === -1) {
      instances.push(instance);
    } else {
      instances[index] = instance;
    }

    // Cap at MAX_INSTANCES — purge oldest (by startedAt) on overflow
    if (instances.length > MAX_INSTANCES) {
      instances.sort(
        (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime(),
      );
      instances.splice(0, instances.length - MAX_INSTANCES);
    }

    store.set('automation.instances', instances);
  }

  async cleanOldInstances(): Promise<void> {
    const store = await getStore();
    const instances = await this.listInstances();

    if (instances.length > MAX_INSTANCES) {
      instances.sort(
        (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime(),
      );
      instances.splice(0, instances.length - MAX_INSTANCES);
      store.set('automation.instances', instances);
      logger.debug(`[WorkflowStore] Pruned instances to ${MAX_INSTANCES}`);
    }
  }
}

export const workflowStore = new WorkflowStore();
