/**
 * Automation Store
 * Manages event trigger state
 */
import { create } from 'zustand';
import type {
  EventTrigger,
  EventTriggerCreateInput,
  EventTriggerUpdateInput,
} from '../types/automation';

interface AutomationState {
  triggers: EventTrigger[];
  loading: boolean;
  error: string | null;

  fetchTriggers: () => Promise<void>;
  createTrigger: (input: EventTriggerCreateInput) => Promise<EventTrigger>;
  updateTrigger: (id: string, input: EventTriggerUpdateInput) => Promise<void>;
  deleteTrigger: (id: string) => Promise<void>;
  toggleTrigger: (id: string, enabled: boolean) => Promise<void>;
}

export const useAutomationStore = create<AutomationState>((set) => ({
  triggers: [],
  loading: false,
  error: null,

  fetchTriggers: async () => {
    set({ loading: true, error: null });
    try {
      const result = await window.electron.ipcRenderer.invoke(
        'automation:list-triggers',
      ) as EventTrigger[];
      set({ triggers: result, loading: false });
    } catch (error) {
      set({ error: String(error), loading: false });
    }
  },

  createTrigger: async (input) => {
    try {
      const trigger = await window.electron.ipcRenderer.invoke(
        'automation:create-trigger',
        input,
      ) as EventTrigger;
      set((state) => ({ triggers: [...state.triggers, trigger] }));
      return trigger;
    } catch (error) {
      console.error('Failed to create trigger:', error);
      throw error;
    }
  },

  updateTrigger: async (id, input) => {
    try {
      const updated = await window.electron.ipcRenderer.invoke(
        'automation:update-trigger',
        id,
        input,
      ) as EventTrigger;
      set((state) => ({
        triggers: state.triggers.map((t) => (t.id === id ? updated : t)),
      }));
    } catch (error) {
      console.error('Failed to update trigger:', error);
      throw error;
    }
  },

  deleteTrigger: async (id) => {
    try {
      await window.electron.ipcRenderer.invoke('automation:delete-trigger', id);
      set((state) => ({ triggers: state.triggers.filter((t) => t.id !== id) }));
    } catch (error) {
      console.error('Failed to delete trigger:', error);
      throw error;
    }
  },

  toggleTrigger: async (id, enabled) => {
    try {
      const updated = await window.electron.ipcRenderer.invoke(
        'automation:toggle-trigger',
        id,
        enabled,
      ) as EventTrigger;
      set((state) => ({
        triggers: state.triggers.map((t) => (t.id === id ? updated : t)),
      }));
    } catch (error) {
      console.error('Failed to toggle trigger:', error);
      throw error;
    }
  },
}));
