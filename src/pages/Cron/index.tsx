/**
 * Cron Page
 * Manage scheduled tasks
 */
import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  Plus,
  Clock,
  Play,
  Pause,
  Trash2,
  Edit,
  RefreshCw,
  X,
  Calendar,
  AlertCircle,
  CheckCircle2,
  XCircle,
  MessageSquare,
  Loader2,
  Timer,
  History,
  ChevronDown,
  ChevronUp,
  Zap,
  Repeat,
  Webhook,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';
import { useCronStore } from '@/stores/cron';
import { useChannelsStore } from '@/stores/channels';
import { useGatewayStore } from '@/stores/gateway';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { formatRelativeTime, cn } from '@/lib/utils';
import { toast } from 'sonner';
import type { CronJob, CronJobCreateInput, CronRunLogEntry, ScheduleType } from '@/types/cron';
import { ChannelIcon } from '@/components/ChannelIcon';
import type { ChannelType } from '@/types/channel';
import { useTranslation } from 'react-i18next';
import { TriggerConfig } from '@/components/automation/TriggerConfig';
import { WebhookConfig } from '@/components/automation/WebhookConfig';
import { useAutomationStore } from '@/stores/automation';
import type { EventTriggerCreateInput } from '@/types/automation';

// Common cron schedule presets
const schedulePresets: { label: string; value: string; type: ScheduleType }[] = [
  { label: 'Every minute', value: '* * * * *', type: 'interval' },
  { label: 'Every 5 minutes', value: '*/5 * * * *', type: 'interval' },
  { label: 'Every 15 minutes', value: '*/15 * * * *', type: 'interval' },
  { label: 'Every hour', value: '0 * * * *', type: 'interval' },
  { label: 'Daily at 9am', value: '0 9 * * *', type: 'daily' },
  { label: 'Daily at 6pm', value: '0 18 * * *', type: 'daily' },
  { label: 'Weekly (Mon 9am)', value: '0 9 * * 1', type: 'weekly' },
  { label: 'Monthly (1st at 9am)', value: '0 9 1 * *', type: 'monthly' },
];

// Parse cron schedule to human-readable format
// Handles both plain cron strings and Gateway CronSchedule objects:
//   { kind: "cron", expr: "...", tz?: "..." }
//   { kind: "every", everyMs: number }
//   { kind: "at", at: "..." }
function parseCronSchedule(schedule: unknown): string {
  // Handle Gateway CronSchedule object format
  if (schedule && typeof schedule === 'object') {
    const s = schedule as { kind?: string; expr?: string; tz?: string; everyMs?: number; at?: string };
    if (s.kind === 'cron' && typeof s.expr === 'string') {
      const label = parseCronExpr(s.expr);
      return s.tz ? `${label} (${s.tz})` : label;
    }
    if (s.kind === 'every' && typeof s.everyMs === 'number') {
      const ms = s.everyMs;
      if (ms < 60_000) return `Every ${Math.round(ms / 1000)}s`;
      if (ms < 3_600_000) return `Every ${Math.round(ms / 60_000)} minutes`;
      if (ms < 86_400_000) return `Every ${Math.round(ms / 3_600_000)} hours`;
      return `Every ${Math.round(ms / 86_400_000)} days`;
    }
    if (s.kind === 'at' && typeof s.at === 'string') {
      try {
        return `Once at ${new Date(s.at).toLocaleString()}`;
      } catch {
        return `Once at ${s.at}`;
      }
    }
    return String(schedule);
  }

  // Handle plain cron string
  if (typeof schedule === 'string') {
    return parseCronExpr(schedule);
  }

  return String(schedule ?? 'Unknown');
}

// Parse a plain cron expression string to human-readable text
function parseCronExpr(cron: string): string {
  const preset = schedulePresets.find((p) => p.value === cron);
  if (preset) return preset.label;

  const parts = cron.split(' ');
  if (parts.length !== 5) return cron;

  const [minute, hour, dayOfMonth, , dayOfWeek] = parts;

  if (minute === '*' && hour === '*') return 'Every minute';
  if (minute.startsWith('*/')) return `Every ${minute.slice(2)} minutes`;
  if (hour === '*' && minute === '0') return 'Every hour';
  if (dayOfWeek !== '*' && dayOfMonth === '*') {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return `Weekly on ${days[parseInt(dayOfWeek)]} at ${hour}:${minute.padStart(2, '0')}`;
  }
  if (dayOfMonth !== '*') {
    return `Monthly on day ${dayOfMonth} at ${hour}:${minute.padStart(2, '0')}`;
  }
  if (hour !== '*') {
    return `Daily at ${hour}:${minute.padStart(2, '0')}`;
  }

  return cron;
}

// Format duration from ms to human-readable (e.g. "1.2s")
function formatDuration(ms?: number): string {
  if (ms === undefined || ms === null) return '-';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// Format token usage
function formatTokens(usage?: { inputTokens?: number; outputTokens?: number }): string {
  if (!usage) return '-';
  const inp = usage.inputTokens ?? 0;
  const out = usage.outputTokens ?? 0;
  if (!inp && !out) return '-';
  return `${inp} in / ${out} out`;
}

// Get all IANA timezone names grouped by region
function getTimezoneGroups(): Record<string, string[]> {
  try {
    const zones = Intl.supportedValuesOf('timeZone');
    const groups: Record<string, string[]> = {};
    for (const tz of zones) {
      const region = tz.includes('/') ? tz.split('/')[0] : 'Other';
      if (!groups[region]) groups[region] = [];
      groups[region].push(tz);
    }
    return groups;
  } catch {
    return {};
  }
}

// Execution History Panel
interface ExecutionHistoryPanelProps {
  job: CronJob;
}

function ExecutionHistoryPanel({ job }: ExecutionHistoryPanelProps) {
  const { t } = useTranslation('cron');
  const { runs, fetchRuns } = useCronStore();
  const [loading, setLoading] = useState(true);

  const jobRuns: CronRunLogEntry[] = runs[job.id] ?? [];

  useEffect(() => {
    let cancelled = false;
    fetchRuns(job.id).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [job.id, fetchRuns]);

  const statusBadgeVariant = (status: CronRunLogEntry['status']) => {
    if (status === 'ok') return 'success' as const;
    if (status === 'error') return 'destructive' as const;
    return 'secondary' as const;
  };

  const statusLabel = (status: CronRunLogEntry['status']) => {
    if (status === 'ok') return t('history.statusOk');
    if (status === 'error') return t('history.statusError');
    return t('history.statusSkipped');
  };

  if (loading) {
    return (
      <div className="flex justify-center py-4">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (jobRuns.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-2 text-center">{t('history.noRuns')}</p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-muted-foreground text-xs">
            <th className="text-left pb-2 pr-4 font-medium">{t('history.time')}</th>
            <th className="text-left pb-2 pr-4 font-medium">{t('history.status')}</th>
            <th className="text-left pb-2 pr-4 font-medium">{t('history.duration')}</th>
            <th className="text-left pb-2 pr-4 font-medium">{t('history.model')}</th>
            <th className="text-left pb-2 font-medium">{t('history.tokens')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {jobRuns.map((run) => (
            <tr key={run.ts} className="hover:bg-muted/30">
              <td className="py-2 pr-4 text-muted-foreground whitespace-nowrap">
                {new Date(run.ts).toLocaleString()}
              </td>
              <td className="py-2 pr-4">
                <div className="flex flex-col gap-1">
                  <Badge variant={statusBadgeVariant(run.status)} className="w-fit text-xs">
                    {statusLabel(run.status)}
                  </Badge>
                  {run.error && (
                    <span className="text-xs text-red-500 line-clamp-1">{run.error}</span>
                  )}
                </div>
              </td>
              <td className="py-2 pr-4 text-muted-foreground">{formatDuration(run.durationMs)}</td>
              <td className="py-2 pr-4 text-muted-foreground">{run.model ?? '-'}</td>
              <td className="py-2 text-muted-foreground">{formatTokens(run.usage)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Timezone Picker — searchable select with region grouping
interface TimezonePickerProps {
  value: string;
  onChange: (tz: string) => void;
  placeholder: string;
}

function TimezonePicker({ value, onChange, placeholder }: TimezonePickerProps) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);

  const timezoneGroups = useMemo(() => getTimezoneGroups(), []);

  const filtered = useMemo(() => {
    if (!search.trim()) return timezoneGroups;
    const q = search.toLowerCase();
    const result: Record<string, string[]> = {};
    for (const [region, zones] of Object.entries(timezoneGroups)) {
      const matched = zones.filter((z) => z.toLowerCase().includes(q));
      if (matched.length > 0) result[region] = matched;
    }
    return result;
  }, [timezoneGroups, search]);

  const displayValue = value || placeholder;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(
          'flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm',
          'focus:outline-none focus:ring-1 focus:ring-ring',
          !value && 'text-muted-foreground',
        )}
      >
        <span className="truncate">{displayValue}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-md">
          <div className="p-2 border-b">
            <Input
              autoFocus
              placeholder="Search..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 text-sm"
            />
          </div>
          {value && (
            <button
              type="button"
              className="w-full px-3 py-2 text-left text-sm text-muted-foreground hover:bg-accent"
              onClick={() => {
                onChange('');
                setSearch('');
                setOpen(false);
              }}
            >
              Clear selection
            </button>
          )}
          <div className="max-h-60 overflow-y-auto">
            {Object.entries(filtered).map(([region, zones]) => (
              <div key={region}>
                <p className="px-3 py-1 text-xs font-semibold text-muted-foreground bg-muted/50 sticky top-0">
                  {region}
                </p>
                {zones.map((tz) => (
                  <button
                    key={tz}
                    type="button"
                    className={cn(
                      'w-full px-3 py-1.5 text-left text-sm hover:bg-accent',
                      tz === value && 'bg-accent font-medium',
                    )}
                    onClick={() => {
                      onChange(tz);
                      setSearch('');
                      setOpen(false);
                    }}
                  >
                    {tz}
                  </button>
                ))}
              </div>
            ))}
            {Object.keys(filtered).length === 0 && (
              <p className="px-3 py-3 text-sm text-muted-foreground text-center">No results</p>
            )}
          </div>
        </div>
      )}
      {open && (
        <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
      )}
    </div>
  );
}

// Create/Edit Task Dialog
interface TaskDialogProps {
  job?: CronJob;
  onClose: () => void;
  onSave: (input: CronJobCreateInput) => Promise<void>;
  onSaveTrigger?: (input: EventTriggerCreateInput) => Promise<void>;
}

function TaskDialog({ job, onClose, onSave, onSaveTrigger }: TaskDialogProps) {
  const { t } = useTranslation('cron');
  const { channels } = useChannelsStore();
  const { jobs: allJobs } = useCronStore();
  const [saving, setSaving] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [triggerType, setTriggerType] = useState<'schedule' | 'event'>('schedule');
  const [triggerInput, setTriggerInput] = useState<EventTriggerCreateInput | null>(null);

  const [name, setName] = useState(job?.name || '');
  const [message, setMessage] = useState(job?.message || '');
  // Extract cron expression string from CronSchedule object or use as-is if string
  const initialSchedule = (() => {
    const s = job?.schedule;
    if (!s) return '0 9 * * *';
    if (typeof s === 'string') return s;
    if (typeof s === 'object' && 'expr' in s && typeof (s as { expr: string }).expr === 'string') {
      return (s as { expr: string }).expr;
    }
    return '0 9 * * *';
  })();
  const [schedule, setSchedule] = useState(initialSchedule);
  const [customSchedule, setCustomSchedule] = useState('');
  const [useCustom, setUseCustom] = useState(false);
  const [channelId, setChannelId] = useState(job?.target.channelId || '');
  const [discordChannelId, setDiscordChannelId] = useState('');
  const [enabled, setEnabled] = useState(job?.enabled ?? true);

  // Advanced fields
  const [tz, setTz] = useState(job?.tz ?? '');
  const [wakeMode, setWakeMode] = useState<'now' | 'next-heartbeat'>(job?.wakeMode ?? 'next-heartbeat');
  const [deleteAfterRun, setDeleteAfterRun] = useState(job?.deleteAfterRun ?? false);

  const selectedChannel = channels.find((c) => c.id === channelId);
  const isDiscord = selectedChannel?.type === 'discord';

  const handleSubmit = async () => {
    // Event trigger path
    if (triggerType === 'event') {
      if (!triggerInput || !triggerInput.jobId) {
        toast.error(t('toast.nameRequired'));
        return;
      }
      if (!onSaveTrigger) return;
      setSaving(true);
      try {
        await onSaveTrigger(triggerInput);
        onClose();
        toast.success(t('toast.created'));
      } catch (err) {
        toast.error(String(err));
      } finally {
        setSaving(false);
      }
      return;
    }

    if (!name.trim()) {
      toast.error(t('toast.nameRequired'));
      return;
    }
    if (!message.trim()) {
      toast.error(t('toast.messageRequired'));
      return;
    }
    if (!channelId) {
      toast.error(t('toast.channelRequired'));
      return;
    }
    // Validate Discord channel ID when Discord is selected
    if (selectedChannel?.type === 'discord' && !discordChannelId.trim()) {
      toast.error(t('toast.discordIdRequired'));
      return;
    }

    const finalSchedule = useCustom ? customSchedule : schedule;
    if (!finalSchedule.trim()) {
      toast.error(t('toast.scheduleRequired'));
      return;
    }

    setSaving(true);
    try {
      // For Discord, use the manually entered channel ID; for others, use empty
      const actualChannelId = selectedChannel!.type === 'discord'
        ? discordChannelId.trim()
        : '';

      await onSave({
        name: name.trim(),
        message: message.trim(),
        schedule: finalSchedule,
        target: {
          channelType: selectedChannel!.type,
          channelId: actualChannelId,
          channelName: selectedChannel!.name,
        },
        enabled,
        tz: tz || undefined,
        wakeMode,
        deleteAfterRun: deleteAfterRun || undefined,
      });
      onClose();
      toast.success(job ? t('toast.updated') : t('toast.created'));
    } catch (err) {
      toast.error(String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <Card className="w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <CardHeader className="flex flex-row items-start justify-between">
          <div>
            <CardTitle>{job ? t('dialog.editTitle') : t('dialog.createTitle')}</CardTitle>
            <CardDescription>{t('dialog.description')}</CardDescription>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Trigger type selector — only shown when creating */}
          {!job && (
            <div className="space-y-2">
              <Label>{t('trigger.type')}</Label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant={triggerType === 'schedule' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setTriggerType('schedule')}
                  className="flex-1"
                >
                  <Clock className="h-4 w-4 mr-2" />
                  {t('trigger.schedule')}
                </Button>
                <Button
                  type="button"
                  variant={triggerType === 'event' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setTriggerType('event')}
                  className="flex-1"
                >
                  <Zap className="h-4 w-4 mr-2" />
                  {t('trigger.event')}
                </Button>
              </div>
            </div>
          )}

          {/* Event Trigger Config */}
          {triggerType === 'event' && !job && (
            <TriggerConfig
              jobs={allJobs}
              onChange={setTriggerInput}
            />
          )}

          {/* Name + schedule fields — only shown for schedule jobs */}
          {(triggerType === 'schedule' || !!job) && (
          <>
          <div className="space-y-2">
            <Label htmlFor="name">{t('dialog.taskName')}</Label>
            <Input
              id="name"
              placeholder={t('dialog.taskNamePlaceholder')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {/* Message */}
          <div className="space-y-2">
            <Label htmlFor="message">{t('dialog.message')}</Label>
            <Textarea
              id="message"
              placeholder={t('dialog.messagePlaceholder')}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
            />
          </div>

          {/* Schedule */}
          <div className="space-y-2">
            <Label>{t('dialog.schedule')}</Label>
            {!useCustom ? (
              <div className="grid grid-cols-2 gap-2">
                {schedulePresets.map((preset) => (
                  <Button
                    key={preset.value}
                    type="button"
                    variant={schedule === preset.value ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setSchedule(preset.value)}
                    className="justify-start"
                  >
                    <Timer className="h-4 w-4 mr-2" />
                    {preset.label === 'Every minute' ? t('presets.everyMinute') :
                      preset.label === 'Every 5 minutes' ? t('presets.every5Min') :
                        preset.label === 'Every 15 minutes' ? t('presets.every15Min') :
                          preset.label === 'Every hour' ? t('presets.everyHour') :
                            preset.label === 'Daily at 9am' ? t('presets.daily9am') :
                              preset.label === 'Daily at 6pm' ? t('presets.daily6pm') :
                                preset.label === 'Weekly (Mon 9am)' ? t('presets.weeklyMon') :
                                  preset.label === 'Monthly (1st at 9am)' ? t('presets.monthly1st') :
                                    preset.label}
                  </Button>
                ))}
              </div>
            ) : (
              <Input
                placeholder={t('dialog.cronPlaceholder')}
                value={customSchedule}
                onChange={(e) => setCustomSchedule(e.target.value)}
              />
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setUseCustom(!useCustom)}
              className="text-xs"
            >
              {useCustom ? t('dialog.usePresets') : t('dialog.useCustomCron')}
            </Button>
          </div>

          {/* Target Channel */}
          <div className="space-y-2">
            <Label>{t('dialog.targetChannel')}</Label>
            {channels.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('dialog.noChannels')}
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {channels.map((channel) => (
                  <Button
                    key={channel.id}
                    type="button"
                    variant={channelId === channel.id ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setChannelId(channel.id)}
                    className="justify-start"
                  >
                    <ChannelIcon type={channel.type as ChannelType} size="sm" className="mr-2" />
                    {channel.name}
                  </Button>
                ))}
              </div>
            )}
          </div>

          {/* Discord Channel ID - only shown when Discord is selected */}
          {isDiscord && (
            <div className="space-y-2">
              <Label>{t('dialog.discordChannelId')}</Label>
              <Input
                value={discordChannelId}
                onChange={(e) => setDiscordChannelId(e.target.value)}
                placeholder={t('dialog.discordChannelIdPlaceholder')}
              />
              <p className="text-xs text-muted-foreground">
                {t('dialog.discordChannelIdDesc')}
              </p>
            </div>
          )}

          {/* Enabled */}
          <div className="flex items-center justify-between">
            <div>
              <Label>{t('dialog.enableImmediately')}</Label>
              <p className="text-sm text-muted-foreground">
                {t('dialog.enableImmediatelyDesc')}
              </p>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </div>

          {/* Advanced Options (collapsible) */}
          <div className="border rounded-lg">
            <button
              type="button"
              className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium hover:bg-muted/50 rounded-lg transition-colors"
              onClick={() => setShowAdvanced(!showAdvanced)}
            >
              <span>{t('dialog.advanced')}</span>
              {showAdvanced ? (
                <ChevronUp className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              )}
            </button>
            {showAdvanced && (
              <div className="px-4 pb-4 space-y-4 border-t pt-4">
                {/* Timezone */}
                <div className="space-y-2">
                  <Label>{t('dialog.timezone')}</Label>
                  <TimezonePicker
                    value={tz}
                    onChange={setTz}
                    placeholder={t('dialog.timezonePlaceholder')}
                  />
                  <p className="text-xs text-muted-foreground">{t('dialog.timezoneDesc')}</p>
                </div>

                {/* Priority */}
                <div className="space-y-2">
                  <Label>{t('dialog.priority')}</Label>
                  <Select
                    value={wakeMode}
                    onChange={(e) => setWakeMode(e.target.value as 'now' | 'next-heartbeat')}
                  >
                    <option value="now">{t('dialog.priorityHigh')}</option>
                    <option value="next-heartbeat">{t('dialog.priorityNormal')}</option>
                  </Select>
                </div>

                {/* One-shot */}
                <div className="flex items-center justify-between">
                  <div>
                    <Label>{t('dialog.oneShot')}</Label>
                    <p className="text-sm text-muted-foreground">{t('dialog.oneShotDesc')}</p>
                  </div>
                  <Switch checked={deleteAfterRun} onCheckedChange={setDeleteAfterRun} />
                </div>
              </div>
            )}
          </div>
          </>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-4 border-t">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={saving}>
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-4 w-4 mr-2" />
                  {job ? t('dialog.saveChanges') : t('dialog.createTitle')}
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// Job Card Component
interface CronJobCardProps {
  job: CronJob;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  onTrigger: () => Promise<void>;
  onWebhook: () => void;
}

function CronJobCard({ job, onToggle, onEdit, onDelete, onTrigger, onWebhook }: CronJobCardProps) {
  const { t } = useTranslation('cron');
  const [triggering, setTriggering] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const handleTrigger = async () => {
    setTriggering(true);
    try {
      await onTrigger();
      toast.success(t('toast.triggered'));
    } catch (error) {
      console.error('Failed to trigger cron job:', error);
      toast.error(`Failed to trigger task: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setTriggering(false);
    }
  };

  const handleDelete = () => {
    if (confirm(t('card.deleteConfirm'))) {
      onDelete();
    }
  };

  // Extract tz from schedule object if not directly on job
  const scheduleTz = (() => {
    if (job.tz) return job.tz;
    if (job.schedule && typeof job.schedule === 'object' && 'tz' in job.schedule) {
      return (job.schedule as { tz?: string }).tz;
    }
    return undefined;
  })();

  return (
    <Card className={cn(
      'transition-colors',
      job.enabled && 'border-primary/30'
    )}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className={cn(
              'rounded-full p-2',
              job.enabled
                ? 'bg-green-100 dark:bg-green-900/30'
                : 'bg-muted'
            )}>
              <Clock className={cn(
                'h-5 w-5',
                job.enabled ? 'text-green-600' : 'text-muted-foreground'
              )} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <CardTitle className="text-lg">{job.name}</CardTitle>
                {job.deleteAfterRun && (
                  <Badge variant="outline" className="text-xs">
                    <Repeat className="h-3 w-3 mr-1" />
                    {t('card.oneShot')}
                  </Badge>
                )}
                {job.wakeMode === 'now' && (
                  <Badge variant="outline" className="text-xs text-amber-600 border-amber-400">
                    <Zap className="h-3 w-3 mr-1" />
                    {t('card.highPriority')}
                  </Badge>
                )}
              </div>
              <CardDescription className="flex items-center gap-2">
                <Timer className="h-3 w-3" />
                {parseCronSchedule(job.schedule)}
                {scheduleTz && (
                  <Badge variant="secondary" className="text-xs font-normal">
                    {scheduleTz}
                  </Badge>
                )}
              </CardDescription>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={job.enabled ? 'success' : 'secondary'}>
              {job.enabled ? t('stats.active') : t('stats.paused')}
            </Badge>
            <Switch
              checked={job.enabled}
              onCheckedChange={onToggle}
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Message Preview */}
        <div className="flex items-start gap-2 p-3 rounded-lg bg-muted/50">
          <MessageSquare className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
          <p className="text-sm text-muted-foreground line-clamp-2">
            {job.message}
          </p>
        </div>

        {/* Metadata */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
          <span className="flex items-center gap-1">
            <ChannelIcon type={job.target.channelType as ChannelType} size="sm" />
            {job.target.channelName}
          </span>

          {job.lastRun && (
            <span className="flex items-center gap-1">
              <History className="h-4 w-4" />
              {t('card.last')}: {formatRelativeTime(job.lastRun.time)}
              {job.lastRun.success ? (
                <CheckCircle2 className="h-4 w-4 text-green-500" />
              ) : (
                <XCircle className="h-4 w-4 text-red-500" />
              )}
            </span>
          )}

          {job.nextRun && job.enabled && (
            <span className="flex items-center gap-1">
              <Calendar className="h-4 w-4" />
              {t('card.next')}: {new Date(job.nextRun).toLocaleString()}
            </span>
          )}
        </div>

        {/* Last Run Error */}
        {job.lastRun && !job.lastRun.success && job.lastRun.error && (
          <div className="flex items-start gap-2 p-2 rounded-lg bg-red-50 dark:bg-red-900/20 text-sm text-red-600 dark:text-red-400">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{job.lastRun.error}</span>
          </div>
        )}

        {/* Execution History Panel */}
        {showHistory && (
          <div className="border rounded-lg p-3">
            <p className="text-sm font-medium mb-3">{t('history.title')}</p>
            <ExecutionHistoryPanel job={job} />
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-1 pt-2 border-t">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowHistory(!showHistory)}
          >
            <History className="h-4 w-4" />
            <span className="ml-1">{t('card.history')}</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleTrigger}
            disabled={triggering}
          >
            {triggering ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            <span className="ml-1">{t('card.runNow')}</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={onWebhook}>
            <Webhook className="h-4 w-4" />
            <span className="ml-1">{t('webhook.buttonLabel')}</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={onEdit}>
            <Edit className="h-4 w-4" />
            <span className="ml-1">Edit</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={handleDelete}>
            <Trash2 className="h-4 w-4 text-destructive" />
            <span className="ml-1 text-destructive">Delete</span>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function Cron() {
  const { t } = useTranslation('cron');
  const { jobs, loading, error, fetchJobs, createJob, updateJob, toggleJob, deleteJob, triggerJob } = useCronStore();
  const { fetchChannels } = useChannelsStore();
  const { createTrigger } = useAutomationStore();
  const gatewayStatus = useGatewayStore((state) => state.status);
  const [showDialog, setShowDialog] = useState(false);
  const [editingJob, setEditingJob] = useState<CronJob | undefined>();
  const [webhookJobId, setWebhookJobId] = useState<string | undefined>();

  const isGatewayRunning = gatewayStatus.state === 'running';

  // Fetch jobs and channels on mount
  useEffect(() => {
    if (isGatewayRunning) {
      fetchJobs();
      fetchChannels();
    }
  }, [fetchJobs, fetchChannels, isGatewayRunning]);

  // Statistics
  const activeJobs = jobs.filter((j) => j.enabled);
  const pausedJobs = jobs.filter((j) => !j.enabled);
  const failedJobs = jobs.filter((j) => j.lastRun && !j.lastRun.success);

  const handleSave = useCallback(async (input: CronJobCreateInput) => {
    if (editingJob) {
      await updateJob(editingJob.id, input);
    } else {
      await createJob(input);
    }
  }, [editingJob, createJob, updateJob]);

  const handleSaveTrigger = useCallback(async (input: EventTriggerCreateInput) => {
    await createTrigger(input);
  }, [createTrigger]);

  const handleToggle = useCallback(async (id: string, enabled: boolean) => {
    try {
      await toggleJob(id, enabled);
      toast.success(enabled ? t('toast.enabled') : t('toast.paused'));
    } catch {
      toast.error(t('toast.failedUpdate'));
    }
  }, [toggleJob, t]);

  const handleDelete = useCallback(async (id: string) => {
    try {
      await deleteJob(id);
      toast.success(t('toast.deleted'));
    } catch {
      toast.error(t('toast.failedDelete'));
    }
  }, [deleteJob, t]);

  if (loading) {
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
          <p className="text-muted-foreground">
            {t('subtitle')}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={fetchJobs} disabled={!isGatewayRunning}>
            <RefreshCw className="h-4 w-4 mr-2" />
            {t('refresh')}
          </Button>
          <Button
            onClick={() => {
              setEditingJob(undefined);
              setShowDialog(true);
            }}
            disabled={!isGatewayRunning}
          >
            <Plus className="h-4 w-4 mr-2" />
            {t('newTask')}
          </Button>
        </div>
      </div>

      {/* Gateway Warning */}
      {!isGatewayRunning && (
        <Card className="border-yellow-500 bg-yellow-50 dark:bg-yellow-900/10">
          <CardContent className="py-4 flex items-center gap-3">
            <AlertCircle className="h-5 w-5 text-yellow-600" />
            <span className="text-yellow-700 dark:text-yellow-400">
              {t('gatewayWarning')}
            </span>
          </CardContent>
        </Card>
      )}

      {/* Statistics */}
      <div className="grid grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <div className="rounded-full bg-primary/10 p-3">
                <Clock className="h-6 w-6 text-primary" />
              </div>
              <div>
                <p className="text-2xl font-bold">{jobs.length}</p>
                <p className="text-sm text-muted-foreground">{t('stats.total')}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <div className="rounded-full bg-green-100 p-3 dark:bg-green-900/30">
                <Play className="h-6 w-6 text-green-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">{activeJobs.length}</p>
                <p className="text-sm text-muted-foreground">{t('stats.active')}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <div className="rounded-full bg-yellow-100 p-3 dark:bg-yellow-900/30">
                <Pause className="h-6 w-6 text-yellow-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">{pausedJobs.length}</p>
                <p className="text-sm text-muted-foreground">{t('stats.paused')}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <div className="rounded-full bg-red-100 p-3 dark:bg-red-900/30">
                <XCircle className="h-6 w-6 text-red-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">{failedJobs.length}</p>
                <p className="text-sm text-muted-foreground">{t('stats.failed')}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Error Display */}
      {error && (
        <Card className="border-destructive">
          <CardContent className="py-4 text-destructive flex items-center gap-2">
            <AlertCircle className="h-5 w-5" />
            {error}
          </CardContent>
        </Card>
      )}

      {/* Jobs List */}
      {jobs.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Clock className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">{t('empty.title')}</h3>
            <p className="text-muted-foreground text-center mb-4 max-w-md">
              {t('empty.description')}
            </p>
            <Button
              onClick={() => {
                setEditingJob(undefined);
                setShowDialog(true);
              }}
              disabled={!isGatewayRunning}
            >
              <Plus className="h-4 w-4 mr-2" />
              {t('empty.create')}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {jobs.map((job) => (
            <CronJobCard
              key={job.id}
              job={job}
              onToggle={(enabled) => handleToggle(job.id, enabled)}
              onEdit={() => {
                setEditingJob(job);
                setShowDialog(true);
              }}
              onDelete={() => handleDelete(job.id)}
              onTrigger={() => triggerJob(job.id)}
              onWebhook={() => setWebhookJobId(job.id)}
            />
          ))}
        </div>
      )}

      {/* Create/Edit Dialog */}
      {showDialog && (
        <TaskDialog
          job={editingJob}
          onClose={() => {
            setShowDialog(false);
            setEditingJob(undefined);
          }}
          onSave={handleSave}
          onSaveTrigger={handleSaveTrigger}
        />
      )}

      {/* Webhook Config Dialog */}
      {webhookJobId && (
        <WebhookConfig
          jobId={webhookJobId}
          onClose={() => setWebhookJobId(undefined)}
        />
      )}
    </div>
  );
}

export default Cron;
