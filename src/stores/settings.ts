/**
 * Settings State Store
 * Manages application settings
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import i18n from '@/i18n';

type Theme = 'light' | 'dark' | 'system';
type UpdateChannel = 'stable' | 'beta' | 'dev';
type DmScope = 'main' | 'per-peer' | 'per-channel-peer' | 'per-account-channel-peer';

interface SettingsState {
  // General
  theme: Theme;
  language: string;
  startMinimized: boolean;
  launchAtStartup: boolean;

  // Gateway
  gatewayAutoStart: boolean;
  gatewayPort: number;

  // Update
  updateChannel: UpdateChannel;
  autoCheckUpdate: boolean;
  autoDownloadUpdate: boolean;

  // UI State
  sidebarCollapsed: boolean;
  devModeUnlocked: boolean;

  // Agent behavior
  toolsAutoApprove: boolean;
  sessionDmScope: DmScope;

  // Browser / Screenshot
  useBuiltinBrowser: boolean;
  screenshotMaxSide: number;

  // Setup
  setupComplete: boolean;

  // Actions
  setTheme: (theme: Theme) => void;
  setLanguage: (language: string) => void;
  setStartMinimized: (value: boolean) => void;
  setLaunchAtStartup: (value: boolean) => void;
  setGatewayAutoStart: (value: boolean) => void;
  setGatewayPort: (port: number) => void;
  setUpdateChannel: (channel: UpdateChannel) => void;
  setAutoCheckUpdate: (value: boolean) => void;
  setAutoDownloadUpdate: (value: boolean) => void;
  setSidebarCollapsed: (value: boolean) => void;
  setDevModeUnlocked: (value: boolean) => void;
  setToolsAutoApprove: (value: boolean) => void;
  setSessionDmScope: (value: DmScope) => void;
  setUseBuiltinBrowser: (value: boolean) => void;
  setScreenshotMaxSide: (value: number) => void;
  syncFromMain: () => Promise<void>;
  markSetupComplete: () => void;
  resetSettings: () => void;
}

const defaultSettings = {
  theme: 'system' as Theme,
  language: (() => {
    const lang = navigator.language.toLowerCase();
    if (lang.startsWith('vi')) return 'vi';
    return 'en';
  })(),
  startMinimized: true,
  launchAtStartup: true,
  gatewayAutoStart: true,
  gatewayPort: 18789,
  updateChannel: 'stable' as UpdateChannel,
  autoCheckUpdate: true,
  autoDownloadUpdate: false,
  sidebarCollapsed: false,
  devModeUnlocked: false,
  toolsAutoApprove: true,
  sessionDmScope: 'main' as DmScope,
  setupComplete: false,
  useBuiltinBrowser: true,
  screenshotMaxSide: 2000,
};

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      ...defaultSettings,

      setTheme: (theme) => set({ theme }),
      setLanguage: (language) => { i18n.changeLanguage(language); set({ language }); },
      setStartMinimized: (startMinimized) => {
        window.electron.ipcRenderer.invoke('app:setStartMinimized', startMinimized);
        set({ startMinimized });
      },
      setLaunchAtStartup: (launchAtStartup) => {
        window.electron.ipcRenderer.invoke('app:setAutoStart', launchAtStartup);
        set({ launchAtStartup });
      },
      setGatewayAutoStart: (gatewayAutoStart) => set({ gatewayAutoStart }),
      setGatewayPort: (gatewayPort) => set({ gatewayPort }),
      setUpdateChannel: (updateChannel) => set({ updateChannel }),
      setAutoCheckUpdate: (autoCheckUpdate) => set({ autoCheckUpdate }),
      setAutoDownloadUpdate: (autoDownloadUpdate) => set({ autoDownloadUpdate }),
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      setDevModeUnlocked: (devModeUnlocked) => set({ devModeUnlocked }),
      setToolsAutoApprove: (toolsAutoApprove) => {
        window.electron.ipcRenderer.invoke('app:setToolsAutoApprove', toolsAutoApprove);
        set({ toolsAutoApprove });
      },
      setSessionDmScope: (sessionDmScope) => {
        window.electron.ipcRenderer.invoke('app:setSessionDmScope', sessionDmScope);
        set({ sessionDmScope });
      },
      setUseBuiltinBrowser: (useBuiltinBrowser) => {
        window.electron.ipcRenderer.invoke('app:setUseBuiltinBrowser', useBuiltinBrowser);
        set({ useBuiltinBrowser });
      },
      setScreenshotMaxSide: (screenshotMaxSide) => {
        window.electron.ipcRenderer.invoke('app:setScreenshotMaxSide', screenshotMaxSide);
        set({ screenshotMaxSide });
      },
      syncFromMain: async () => {
        try {
          const result = await window.electron.ipcRenderer.invoke('app:getOpenclawSettings') as {
            toolsAutoApprove: boolean;
            sessionDmScope: DmScope;
            screenshotMaxSide?: number;
            useBuiltinBrowser?: boolean;
          };
          set({
            toolsAutoApprove: result.toolsAutoApprove,
            sessionDmScope: result.sessionDmScope,
            ...(result.screenshotMaxSide ? { screenshotMaxSide: result.screenshotMaxSide } : {}),
            ...(typeof result.useBuiltinBrowser === 'boolean' ? { useBuiltinBrowser: result.useBuiltinBrowser } : {}),
          });
        } catch {
          // IPC may not be ready yet on very early calls — ignore
        }
      },
      markSetupComplete: () => set({ setupComplete: true }),
      resetSettings: () => set(defaultSettings),
    }),
    {
      name: 'crawbot-settings',
    }
  )
);

// Sync OpenClaw settings from openclaw.json on app load (not just when Settings page mounts).
// This ensures Zustand/localStorage reflects any manual edits to openclaw.json.
useSettingsStore.getState().syncFromMain();
