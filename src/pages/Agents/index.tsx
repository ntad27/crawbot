/**
 * Agents Page
 * Manage OpenClaw AI agents with CRUD operations, workspace file editing,
 * and channel binding.
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Plus,
  RefreshCw,
  Trash2,
  Bot,
  Save,
  FileText,
  FolderOpen,
  Star,
  X,
  Loader2,
  Settings2,
  Eye,
  Radio,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import data from '@emoji-mart/data';
import Picker from '@emoji-mart/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Select } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useAgentsStore } from '@/stores/agents';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import type { Agent, AgentCreateInput, AgentDefaults, WorkspaceFile } from '@/types/agent';
import { resolveAgentModel, resolveAgentWorkspace, resolveAgentName } from '@/types/agent';
import { useModelsStore } from '@/stores/models';
import { useProviderStore } from '@/stores/providers';
import { useTranslation } from 'react-i18next';

// ─── Emoji Picker (emoji-mart — full Unicode set) ───────────────────

function EmojiPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (emoji: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div className="relative" ref={pickerRef}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(
          'flex h-10 w-full items-center justify-center rounded-md border border-input',
          'bg-background text-2xl hover:bg-accent transition-colors'
        )}
      >
        {value || '🤖'}
      </button>
      {open && (
        <div className="absolute top-12 right-0 z-50">
          <Picker
            data={data}
            onEmojiSelect={(emoji: { native: string }) => {
              onChange(emoji.native);
              setOpen(false);
            }}
            theme="dark"
            previewPosition="none"
            skinTonePosition="search"
            perLine={8}
            maxFrequentRows={2}
          />
        </div>
      )}
    </div>
  );
}

// ─── Workspace Folder Selector ──────────────────────────────────────

function WorkspaceSelector({
  value,
  onChange,
  defaultWorkspace,
}: {
  value: string;
  onChange: (path: string) => void;
  defaultWorkspace?: string;
}) {
  const { t } = useTranslation('agents');
  const [folders, setFolders] = useState<string[]>([]);
  const [basePath, setBasePath] = useState('');
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creating, setCreating] = useState(false);

  // Fetch folders on mount
  useEffect(() => {
    const fetchFolders = async () => {
      try {
        const result = (await window.electron.ipcRenderer.invoke('agent:listFolders')) as {
          success: boolean;
          folders?: string[];
          basePath?: string;
        };
        if (result.success) {
          setFolders(result.folders ?? []);
          setBasePath(result.basePath ?? '');
        }
      } catch {
        // ignore
      }
    };
    fetchFolders();
  }, []);

  const handleCreateFolder = async () => {
    const suffix = newFolderName.trim().replace(/[^a-zA-Z0-9._-]/g, '');
    if (!suffix) return;
    const name = `workspace-${suffix}`;
    setCreating(true);
    try {
      const result = (await window.electron.ipcRenderer.invoke('agent:createFolder', name)) as {
        success: boolean;
        path?: string;
      };
      if (result.success && result.path) {
        setFolders((prev) => [...prev, name].sort());
        onChange(result.path);
        toast.success(t('workspace.created'));
        setShowNewFolder(false);
        setNewFolderName('');
      } else {
        toast.error(t('workspace.createFailed'));
      }
    } catch {
      toast.error(t('workspace.createFailed'));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="flex-1"
        >
          <option value="">
            {defaultWorkspace
              ? `${defaultWorkspace.split('/').pop()} (default)`
              : t('workspace.selectFolder')}
          </option>
          {folders.map((folder) => {
            const fullPath = `${basePath}/${folder}`;
            return (
              <option key={folder} value={fullPath}>
                {folder}
              </option>
            );
          })}
        </Select>
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => setShowNewFolder(!showNewFolder)}
          title={t('workspace.newFolder')}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      {showNewFolder && (() => {
        const suffix = newFolderName.trim().replace(/[^a-zA-Z0-9._-]/g, '');
        const folderDuplicate = suffix.length > 0 && folders.includes(`workspace-${suffix}`);
        return (
        <div className="space-y-1">
          <div className="flex gap-2 items-center p-2 rounded-md border bg-muted/50">
            <div className={cn(
              'flex items-center flex-1 h-8 rounded-md border bg-background text-sm overflow-hidden',
              folderDuplicate ? 'border-destructive' : 'border-input',
            )}>
              <span className="px-2 text-muted-foreground bg-muted border-r border-input shrink-0 h-full flex items-center text-xs">
                workspace-
              </span>
              <input
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value.replace(/[^a-zA-Z0-9._-]/g, ''))}
                placeholder={t('workspace.newFolderPlaceholder')}
                className="flex-1 h-full px-2 bg-transparent outline-none"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !folderDuplicate) handleCreateFolder();
                  if (e.key === 'Escape') {
                    setShowNewFolder(false);
                    setNewFolderName('');
                  }
                }}
              />
            </div>
            <Button
              size="sm"
              variant="default"
              onClick={handleCreateFolder}
              disabled={!newFolderName.trim() || folderDuplicate || creating}
              className="h-8"
            >
            {creating ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              t('workspace.create')
            )}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setShowNewFolder(false);
              setNewFolderName('');
            }}
            className="h-8"
          >
            <X className="h-3 w-3" />
          </Button>
          </div>
          {folderDuplicate && (
            <p className="text-xs text-destructive px-2">{t('workspace.folderDuplicate')}</p>
          )}
        </div>
        );
      })()}

      {value && (
        <p className="text-xs text-muted-foreground font-mono truncate">{value}</p>
      )}
    </div>
  );
}

// ─── Model Select (from Gateway models.list) ────────────────────────

function ModelSelect({
  value,
  defaultModel,
  onChange,
}: {
  value: string;
  defaultModel?: string;
  onChange: (model: string) => void;
}) {
  const { t } = useTranslation('agents');
  const models = useModelsStore((s) => s.models);
  const configuredProviders = useProviderStore((s) => s.providers);

  const configuredProviderTypes = useMemo(
    () => new Set<string>(configuredProviders.map((p) => p.type)),
    [configuredProviders],
  );

  // Filter models to only configured providers, then group by provider
  const grouped = useMemo(() => {
    const groups: Record<string, typeof models> = {};
    for (const model of models) {
      const provider = model.provider || 'other';
      if (!configuredProviderTypes.has(provider)) continue;
      if (!groups[provider]) groups[provider] = [];
      groups[provider].push(model);
    }
    return groups;
  }, [models, configuredProviderTypes]);

  const providers = Object.keys(grouped).sort();

  return (
    <Select
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">
        {defaultModel
          ? `${defaultModel} (default)`
          : t('settings.modelPlaceholder')}
      </option>
      {providers.map((provider) => (
        <optgroup key={provider} label={provider}>
          {grouped[provider].map((model) => (
            <option
              key={`${model.provider}/${model.id}`}
              value={`${model.provider}/${model.id}`}
            >
              {model.name || model.id}
            </option>
          ))}
        </optgroup>
      ))}
    </Select>
  );
}

// ─── Agent Card (sidebar list item) ──────────────────────────────────

function AgentCard({
  agent,
  selected,
  collapsed,
  onClick,
}: {
  agent: Agent;
  selected: boolean;
  collapsed: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation('agents');
  const displayName = resolveAgentName(agent);
  const emoji = agent.identity?.emoji || '🤖';

  return (
    <button
      onClick={onClick}
      title={collapsed ? `${displayName} (${agent.id})` : undefined}
      className={cn(
        'w-full text-left rounded-lg border transition-colors',
        'hover:bg-accent hover:text-accent-foreground',
        selected
          ? 'border-primary bg-accent text-accent-foreground'
          : 'border-transparent',
        collapsed ? 'p-2 flex justify-center' : 'p-3'
      )}
    >
      {collapsed ? (
        <span className="text-2xl">{emoji}</span>
      ) : (
        <div className="flex items-center gap-3">
          <span className="text-2xl">{emoji}</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium truncate">{displayName}</span>
              {agent.default && (
                <Badge variant="secondary" className="text-xs shrink-0">
                  <Star className="h-3 w-3 mr-1" />
                  {t('default')}
                </Badge>
              )}
            </div>
            <span className="text-xs text-muted-foreground truncate block">
              {agent.id}
            </span>
          </div>
        </div>
      )}
    </button>
  );
}

// ─── Create Agent Dialog ─────────────────────────────────────────────

function CreateAgentDialog({
  open,
  defaults,
  existingAgentIds,
  onClose,
  onCreate,
}: {
  open: boolean;
  defaults: AgentDefaults | null;
  existingAgentIds: string[];
  onClose: () => void;
  onCreate: (input: AgentCreateInput) => Promise<void>;
}) {
  const { t } = useTranslation('agents');
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('🤖');
  const [workspace, setWorkspace] = useState('');
  const [model, setModel] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [creating, setCreating] = useState(false);

  const idDuplicate = id.trim().length > 0 && existingAgentIds.includes(id.trim());

  const handleCreate = async () => {
    if (!id.trim() || !name.trim() || idDuplicate) return;
    setCreating(true);
    try {
      await onCreate({
        id: id.trim(),
        name: name.trim(),
        emoji,
        workspace: workspace.trim() || undefined,
        model: model.trim() || undefined,
        isDefault,
      });
      // Reset form
      setId('');
      setName('');
      setEmoji('🤖');
      setWorkspace('');
      setModel('');
      setIsDefault(false);
      onClose();
    } catch {
      // error toast handled in caller
    } finally {
      setCreating(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <Card className="w-full max-w-md mx-4">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>{t('create.title')}</CardTitle>
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="agent-id">{t('create.id')}</Label>
            <Input
              id="agent-id"
              value={id}
              onChange={(e) => setId(e.target.value.toLowerCase().replace(/[^a-z0-9-_]/g, ''))}
              placeholder={t('create.idPlaceholder')}
              className={idDuplicate ? 'border-destructive' : ''}
            />
            {idDuplicate ? (
              <p className="text-xs text-destructive">{t('create.idDuplicate')}</p>
            ) : (
              <p className="text-xs text-muted-foreground">{t('create.idHelp')}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="agent-name">{t('create.name')}</Label>
            <Input
              id="agent-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('create.namePlaceholder')}
            />
          </div>

          <div className="space-y-2">
            <Label>{t('create.emoji')}</Label>
            <EmojiPicker value={emoji} onChange={setEmoji} />
          </div>

          <div className="space-y-2">
            <Label>{t('workspace.label')}</Label>
            <WorkspaceSelector
              value={workspace}
              onChange={setWorkspace}
              defaultWorkspace={defaults?.workspace}
            />
          </div>

          <div className="space-y-2">
            <Label>{t('create.model')}</Label>
            <ModelSelect
              value={model}
              defaultModel={defaults?.model?.primary}
              onChange={setModel}
            />
          </div>

          <div className="flex items-center gap-2">
            <Switch
              id="agent-default"
              checked={isDefault}
              onCheckedChange={setIsDefault}
            />
            <Label htmlFor="agent-default">{t('create.setDefault')}</Label>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose}>
              {t('create.cancel')}
            </Button>
            <Button
              onClick={handleCreate}
              disabled={!id.trim() || !name.trim() || idDuplicate || creating}
            >
              {creating && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {creating ? t('create.creating') : t('create.create')}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Delete Confirm Dialog ───────────────────────────────────────────

function DeleteConfirmDialog({
  agent,
  open,
  onClose,
  onConfirm,
}: {
  agent: Agent | null;
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation('agents');

  if (!open || !agent) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <Card className="w-full max-w-sm mx-4">
        <CardHeader>
          <CardTitle className="text-destructive">{t('delete.title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p>{t('delete.confirm', { name: resolveAgentName(agent) })}</p>
          <p className="text-sm text-muted-foreground">{t('delete.description')}</p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              {t('delete.cancel')}
            </Button>
            <Button variant="destructive" onClick={onConfirm}>
              <Trash2 className="h-4 w-4 mr-2" />
              {t('delete.delete')}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Overview Tab ────────────────────────────────────────────────────

function AgentOverviewTab({
  agent,
  defaults,
}: {
  agent: Agent;
  defaults: AgentDefaults | null;
}) {
  const { t } = useTranslation('agents');

  const effectiveModel = resolveAgentModel(agent, defaults);
  const effectiveWorkspace = resolveAgentWorkspace(agent, defaults);
  const isModelFromAgent = !!agent.model;
  const isWorkspaceFromAgent = !!agent.workspace;

  const infoRows: { label: string; value: string; badge?: string }[] = [
    { label: t('overview.agentId'), value: agent.id },
    { label: t('overview.name'), value: resolveAgentName(agent) },
    { label: t('overview.emoji'), value: agent.identity?.emoji || '🤖' },
    {
      label: t('overview.workspace'),
      value: effectiveWorkspace || '—',
      badge: isWorkspaceFromAgent ? undefined : 'default',
    },
    {
      label: t('overview.model'),
      value: effectiveModel || '—',
      badge: isModelFromAgent ? undefined : 'default',
    },
    {
      label: t('overview.defaultAgent'),
      value: agent.default ? t('default') : '—',
    },
  ];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Eye className="h-4 w-4" />
            {t('tabs.overview')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {infoRows.map((row) => (
              <div key={row.label} className="flex items-start gap-4">
                <span className="text-sm text-muted-foreground w-32 shrink-0">
                  {row.label}
                </span>
                <span className="text-sm font-mono break-all">
                  {row.value}
                  {row.badge && (
                    <Badge variant="outline" className="ml-2 text-xs font-normal">
                      {row.badge}
                    </Badge>
                  )}
                </span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Settings Tab ────────────────────────────────────────────────────

function AgentSettingsTab({
  agent,
  defaults,
  onUpdate,
}: {
  agent: Agent;
  defaults: AgentDefaults | null;
  onUpdate: () => void;
}) {
  const { t } = useTranslation('agents');
  const { updateAgent } = useAgentsStore();

  const [name, setName] = useState(agent.name ?? resolveAgentName(agent));
  const [emoji, setEmoji] = useState(agent.identity?.emoji ?? '🤖');
  const [workspace, setWorkspace] = useState(agent.workspace ?? '');
  const [model, setModel] = useState(
    typeof agent.model === 'string'
      ? agent.model
      : agent.model?.primary ?? ''
  );
  const [isDefault, setIsDefault] = useState(agent.default ?? false);
  const [saving, setSaving] = useState(false);

  // Sync form when agent changes
  useEffect(() => {
    setName(agent.name ?? resolveAgentName(agent));
    setEmoji(agent.identity?.emoji ?? '🤖');
    setWorkspace(agent.workspace ?? '');
    setModel(
      typeof agent.model === 'string'
        ? agent.model
        : agent.model?.primary ?? ''
    );
    setIsDefault(agent.default ?? false);
  }, [agent]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateAgent(agent.id, {
        name,
        emoji,
        workspace: workspace || undefined,
        model: model.trim() || null,
        default: isDefault,
      });
      toast.success(t('settings.saved'));
      onUpdate();
    } catch {
      toast.error(t('settings.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Settings2 className="h-4 w-4" />
            {t('settings.title')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-[1fr,64px] gap-4">
            <div className="space-y-2">
              <Label htmlFor="edit-name">{t('settings.name')}</Label>
              <Input
                id="edit-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('settings.namePlaceholder')}
              />
            </div>
            <div className="space-y-2">
              <Label>{t('settings.emoji')}</Label>
              <EmojiPicker value={emoji} onChange={setEmoji} />
            </div>
          </div>

          <div className="space-y-2">
            <Label>{t('workspace.label')}</Label>
            <WorkspaceSelector
              value={workspace}
              onChange={setWorkspace}
              defaultWorkspace={defaults?.workspace}
            />
          </div>

          <div className="space-y-2">
            <Label>{t('settings.model')}</Label>
            <ModelSelect
              value={model}
              defaultModel={defaults?.model?.primary}
              onChange={setModel}
            />
          </div>

          <div className="flex items-center gap-2">
            <Switch
              id="edit-default"
              checked={isDefault}
              onCheckedChange={setIsDefault}
            />
            <Label htmlFor="edit-default">{t('settings.setDefault')}</Label>
          </div>

          <Separator />

          <div className="flex justify-end">
            <Button onClick={handleSave} disabled={saving || !name.trim()}>
              {saving ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Save className="h-4 w-4 mr-2" />
              )}
              {saving ? t('settings.saving') : t('settings.save')}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Files Tab ───────────────────────────────────────────────────────

function AgentFilesTab({
  agent,
  defaults,
}: {
  agent: Agent;
  defaults: AgentDefaults | null;
}) {
  const { t } = useTranslation('agents');
  const { workspaceFiles, fetchWorkspaceFiles, readFile, writeFile } = useAgentsStore();
  const [selectedFile, setSelectedFile] = useState<WorkspaceFile | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);

  const workspace = resolveAgentWorkspace(agent, defaults);

  // Fetch workspace files when agent changes
  useEffect(() => {
    if (workspace) {
      fetchWorkspaceFiles(workspace);
    }
    setSelectedFile(null);
    setFileContent('');
  }, [workspace, fetchWorkspaceFiles]);

  const handleSelectFile = useCallback(
    async (file: WorkspaceFile) => {
      setSelectedFile(file);
      setLoading(true);
      try {
        const content = await readFile(file.path);
        setFileContent(content);
      } catch {
        setFileContent('');
      } finally {
        setLoading(false);
      }
    },
    [readFile]
  );

  const handleSaveFile = async () => {
    if (!selectedFile) return;
    setSaving(true);
    try {
      await writeFile(selectedFile.path, fileContent);
      toast.success(t('files.saved'));
    } catch {
      toast.error(t('files.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const openFolder = async () => {
    if (!workspace) return;
    try {
      await window.electron.ipcRenderer.invoke('shell:showItemInFolder', workspace);
    } catch {
      // ignore
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <FileText className="h-4 w-4" />
              {t('files.title')}
            </CardTitle>
            <Button variant="outline" size="sm" onClick={openFolder}>
              <FolderOpen className="h-4 w-4 mr-2" />
              {t('files.openFolder')}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {workspaceFiles.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('files.noFiles')}</p>
          ) : (
            <div className="grid grid-cols-[200px,1fr] gap-4 min-h-[400px]">
              {/* File list */}
              <div className="space-y-1 border-r pr-4">
                {workspaceFiles.map((file) => (
                  <button
                    key={file.path}
                    onClick={() => handleSelectFile(file)}
                    className={cn(
                      'w-full text-left text-sm px-2 py-1.5 rounded transition-colors',
                      'hover:bg-accent hover:text-accent-foreground',
                      selectedFile?.path === file.path
                        ? 'bg-accent text-accent-foreground font-medium'
                        : 'text-muted-foreground'
                    )}
                  >
                    <FileText className="h-3.5 w-3.5 inline mr-2" />
                    {file.name}
                  </button>
                ))}
              </div>

              {/* Editor */}
              <div className="flex flex-col">
                {selectedFile ? (
                  <>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium">{selectedFile.name}</span>
                      <Button
                        size="sm"
                        onClick={handleSaveFile}
                        disabled={saving}
                      >
                        {saving ? (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        ) : (
                          <Save className="h-4 w-4 mr-2" />
                        )}
                        {saving ? t('files.saving') : t('files.save')}
                      </Button>
                    </div>
                    {loading ? (
                      <div className="flex-1 flex items-center justify-center">
                        <LoadingSpinner size="sm" />
                      </div>
                    ) : (
                      <Textarea
                        value={fileContent}
                        onChange={(e) => setFileContent(e.target.value)}
                        className="flex-1 min-h-[360px] font-mono text-sm resize-none"
                      />
                    )}
                  </>
                ) : (
                  <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
                    {t('files.noFileSelected')}
                  </div>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Channels Tab ────────────────────────────────────────────────────

function AgentChannelsTab({ selectedAgent }: { selectedAgent: Agent }) {
  const { t } = useTranslation('agents');
  const [channels, setChannels] = useState<string[]>([]);
  const [bindings, setBindings] = useState<Array<{
    agentId: string;
    match: { channel: string; accountId?: string; session?: string };
  }>>([]);

  useEffect(() => {
    const fetchChannels = async () => {
      try {
        const result = (await window.electron.ipcRenderer.invoke('agent:listChannels')) as {
          success: boolean;
          channels?: string[];
        };
        if (result.success && result.channels) {
          setChannels(result.channels);
        }
      } catch {
        // ignore
      }
    };
    fetchChannels();
  }, []);

  useEffect(() => {
    const fetchBindings = async () => {
      try {
        const result = (await window.electron.ipcRenderer.invoke('binding:get')) as {
          success: boolean;
          bindings?: typeof bindings;
        };
        if (result.success && result.bindings) {
          setBindings(result.bindings);
        }
      } catch {
        // ignore
      }
    };
    fetchBindings();
  }, []);

  // Filter bindings to only those matching this agent
  const agentBindings = bindings.filter((b) => b.agentId === selectedAgent.id);

  const handleRemoveBinding = async (channel: string, accountId?: string) => {
    try {
      await window.electron.ipcRenderer.invoke('binding:remove', channel, accountId);
      setBindings((prev) =>
        prev.filter(
          (b) =>
            !(
              b.match.channel === channel &&
              (b.match.accountId || undefined) === (accountId || undefined)
            )
        )
      );
    } catch {
      // ignore
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Radio className="h-4 w-4" />
            {t('channels.title')}
          </CardTitle>
          <CardDescription>{t('channels.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          {channels.length === 0 && agentBindings.length === 0 ? (
            <div className="text-center py-8">
              <Radio className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">{t('channels.noChannels')}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {t('channels.noChannelsDesc')}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {/* Show agent-specific bindings first */}
              {agentBindings.map((binding) => (
                <div
                  key={`${binding.match.channel}-${binding.match.accountId || 'default'}`}
                  className="flex items-center gap-3 p-3 rounded-lg border border-primary/30 bg-primary/5"
                >
                  <Radio className="h-4 w-4 text-primary" />
                  <div className="flex-1">
                    <span className="text-sm font-medium capitalize">
                      {binding.match.channel}
                    </span>
                    {binding.match.accountId && (
                      <span className="text-xs text-muted-foreground ml-2">
                        ({binding.match.accountId})
                      </span>
                    )}
                  </div>
                  <Badge variant="secondary" className="text-xs">
                    {t('channels.bound')}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                    onClick={() =>
                      handleRemoveBinding(binding.match.channel, binding.match.accountId)
                    }
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
              {/* Show all configured channels */}
              {channels
                .filter(
                  (ct) =>
                    !agentBindings.some((b) => b.match.channel === ct && !b.match.accountId)
                )
                .map((channelType) => (
                  <div
                    key={channelType}
                    className="flex items-center gap-3 p-3 rounded-lg border"
                  >
                    <Radio className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium capitalize">{channelType}</span>
                    <Badge variant="secondary" className="ml-auto">
                      {t('enabled')}
                    </Badge>
                  </div>
                ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Main Agents Page ────────────────────────────────────────────────

export function Agents() {
  const { t } = useTranslation('agents');
  const {
    agents,
    defaults,
    loading,
    error,
    selectedAgent,
    fetchAgents,
    createAgent,
    deleteAgent,
    setSelectedAgent,
  } = useAgentsStore();

  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [agentToDelete, setAgentToDelete] = useState<Agent | null>(null);
  const [listCollapsed, setListCollapsed] = useState(false);

  // Fetch agents on mount
  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  const handleCreate = async (input: AgentCreateInput) => {
    try {
      const agent = await createAgent(input);
      toast.success(t('toast.created'));
      setSelectedAgent(agent);
    } catch {
      toast.error(t('toast.createFailed'));
      throw new Error('create failed');
    }
  };

  const handleDelete = async () => {
    if (!agentToDelete) return;
    try {
      await deleteAgent(agentToDelete.id);
      toast.success(t('toast.deleted'));
      setShowDeleteDialog(false);
      setAgentToDelete(null);
    } catch {
      toast.error(t('toast.deleteFailed'));
    }
  };

  const handleRefresh = () => {
    fetchAgents();
  };

  if (loading && agents.length === 0) {
    return (
      <div className="flex h-96 items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground">{t('subtitle')}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleRefresh}>
            <RefreshCw className="h-4 w-4 mr-2" />
            {t('refresh')}
          </Button>
          <Button onClick={() => setShowCreateDialog(true)}>
            <Plus className="h-4 w-4 mr-2" />
            {t('newAgent')}
          </Button>
        </div>
      </div>

      {/* Error Display */}
      {error && (
        <Card className="border-destructive">
          <CardContent className="py-4 text-destructive">{error}</CardContent>
        </Card>
      )}

      {/* Main Content: Master-Detail */}
      {agents.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Bot className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <p className="text-lg font-medium">{t('noAgents')}</p>
            <p className="text-sm text-muted-foreground mt-1">{t('noAgentsDesc')}</p>
            <Button className="mt-4" onClick={() => setShowCreateDialog(true)}>
              <Plus className="h-4 w-4 mr-2" />
              {t('newAgent')}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className={cn(
          'grid gap-6 min-h-[500px] transition-all duration-300',
          listCollapsed ? 'grid-cols-[60px,1fr]' : 'grid-cols-[280px,1fr]'
        )}>
          {/* Agent List (sidebar) */}
          <Card className="h-fit">
            <CardContent className="p-2 space-y-1">
              {agents.map((agent) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  selected={selectedAgent?.id === agent.id}
                  collapsed={listCollapsed}
                  onClick={() => setSelectedAgent(agent)}
                />
              ))}
              <Separator className="my-2" />
              <Button
                variant="ghost"
                size="sm"
                className="w-full"
                onClick={() => setListCollapsed(!listCollapsed)}
              >
                {listCollapsed ? (
                  <PanelLeftOpen className="h-4 w-4" />
                ) : (
                  <PanelLeftClose className="h-4 w-4" />
                )}
              </Button>
            </CardContent>
          </Card>

          {/* Agent Detail */}
          <div>
            {selectedAgent ? (
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="text-3xl">
                        {selectedAgent.identity?.emoji || '🤖'}
                      </span>
                      <div>
                        <CardTitle>{resolveAgentName(selectedAgent)}</CardTitle>
                        <CardDescription>{selectedAgent.id}</CardDescription>
                      </div>
                    </div>
                    {selectedAgent.id !== 'main' && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive hover:text-destructive"
                        onClick={() => {
                          setAgentToDelete(selectedAgent);
                          setShowDeleteDialog(true);
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  <Tabs defaultValue="overview">
                    <TabsList>
                      <TabsTrigger value="overview">{t('tabs.overview')}</TabsTrigger>
                      <TabsTrigger value="settings">{t('tabs.settings')}</TabsTrigger>
                      <TabsTrigger value="files">{t('tabs.files')}</TabsTrigger>
                      <TabsTrigger value="channels">{t('tabs.channels')}</TabsTrigger>
                    </TabsList>
                    <TabsContent value="overview">
                      <AgentOverviewTab
                        agent={selectedAgent}
                        defaults={defaults}
                      />
                    </TabsContent>
                    <TabsContent value="settings">
                      <AgentSettingsTab
                        agent={selectedAgent}
                        defaults={defaults}
                        onUpdate={handleRefresh}
                      />
                    </TabsContent>
                    <TabsContent value="files">
                      <AgentFilesTab
                        agent={selectedAgent}
                        defaults={defaults}
                      />
                    </TabsContent>
                    <TabsContent value="channels">
                      <AgentChannelsTab selectedAgent={selectedAgent} />
                    </TabsContent>
                  </Tabs>
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardContent className="py-20 text-center">
                  <Bot className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
                  <p className="text-muted-foreground">{t('selectAgent')}</p>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      )}

      {/* Dialogs */}
      <CreateAgentDialog
        open={showCreateDialog}
        defaults={defaults}
        existingAgentIds={agents.map((a) => a.id)}
        onClose={() => setShowCreateDialog(false)}
        onCreate={handleCreate}
      />
      <DeleteConfirmDialog
        agent={agentToDelete}
        open={showDeleteDialog}
        onClose={() => {
          setShowDeleteDialog(false);
          setAgentToDelete(null);
        }}
        onConfirm={handleDelete}
      />
    </div>
  );
}
