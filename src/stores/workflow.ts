/**
 * Workflow Store
 * Manages workflow definitions and run instances
 */
import { create } from 'zustand';
import type {
  Workflow,
  WorkflowInstance,
  WorkflowCreateInput,
  WorkflowUpdateInput,
} from '../types/workflow';

interface WorkflowState {
  workflows: Workflow[];
  instances: Record<string, WorkflowInstance[]>;
  loading: boolean;
  error: string | null;

  fetchWorkflows: () => Promise<void>;
  createWorkflow: (input: WorkflowCreateInput) => Promise<Workflow>;
  updateWorkflow: (id: string, input: WorkflowUpdateInput) => Promise<void>;
  deleteWorkflow: (id: string) => Promise<void>;
  toggleWorkflow: (id: string, enabled: boolean) => Promise<void>;
  startWorkflow: (id: string) => Promise<WorkflowInstance>;
  cancelWorkflow: (instanceId: string) => Promise<void>;
  fetchInstances: (workflowId: string) => Promise<void>;
}

export const useWorkflowStore = create<WorkflowState>((set) => ({
  workflows: [],
  instances: {},
  loading: false,
  error: null,

  fetchWorkflows: async () => {
    set({ loading: true, error: null });
    try {
      const result = (await window.electron.ipcRenderer.invoke('workflow:list')) as Workflow[];
      set({ workflows: result, loading: false });
    } catch (error) {
      set({ error: String(error), loading: false });
    }
  },

  createWorkflow: async (input) => {
    try {
      const workflow = (await window.electron.ipcRenderer.invoke(
        'workflow:create',
        input,
      )) as Workflow;
      set((state) => ({ workflows: [...state.workflows, workflow] }));
      return workflow;
    } catch (error) {
      console.error('Failed to create workflow:', error);
      throw error;
    }
  },

  updateWorkflow: async (id, input) => {
    try {
      const updated = (await window.electron.ipcRenderer.invoke(
        'workflow:update',
        id,
        input,
      )) as Workflow;
      set((state) => ({
        workflows: state.workflows.map((w) => (w.id === id ? updated : w)),
      }));
    } catch (error) {
      console.error('Failed to update workflow:', error);
      throw error;
    }
  },

  deleteWorkflow: async (id) => {
    try {
      await window.electron.ipcRenderer.invoke('workflow:delete', id);
      set((state) => ({
        workflows: state.workflows.filter((w) => w.id !== id),
        instances: Object.fromEntries(
          Object.entries(state.instances).filter(([wId]) => wId !== id),
        ),
      }));
    } catch (error) {
      console.error('Failed to delete workflow:', error);
      throw error;
    }
  },

  toggleWorkflow: async (id, enabled) => {
    try {
      const updated = (await window.electron.ipcRenderer.invoke(
        'workflow:toggle',
        id,
        enabled,
      )) as Workflow;
      set((state) => ({
        workflows: state.workflows.map((w) => (w.id === id ? updated : w)),
      }));
    } catch (error) {
      console.error('Failed to toggle workflow:', error);
      throw error;
    }
  },

  startWorkflow: async (id) => {
    try {
      const instance = (await window.electron.ipcRenderer.invoke(
        'workflow:start',
        id,
      )) as WorkflowInstance;
      set((state) => ({
        instances: {
          ...state.instances,
          [id]: [instance, ...(state.instances[id] ?? [])],
        },
      }));
      return instance;
    } catch (error) {
      console.error('Failed to start workflow:', error);
      throw error;
    }
  },

  cancelWorkflow: async (instanceId) => {
    try {
      await window.electron.ipcRenderer.invoke('workflow:cancel', instanceId);
    } catch (error) {
      console.error('Failed to cancel workflow instance:', error);
      throw error;
    }
  },

  fetchInstances: async (workflowId) => {
    try {
      const result = (await window.electron.ipcRenderer.invoke(
        'workflow:instances',
        workflowId,
      )) as WorkflowInstance[];
      set((state) => ({
        instances: {
          ...state.instances,
          [workflowId]: result,
        },
      }));
    } catch (error) {
      console.error('Failed to fetch workflow instances:', error);
    }
  },
}));
