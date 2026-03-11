/**
 * TriggerConfig Component
 * Form for configuring event-driven automation triggers
 */
import { useState } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useTranslation } from 'react-i18next';
import type { CronJob } from '@/types/cron';
import type { EventFilter, EventTrigger, EventTriggerCreateInput, TriggerSource } from '@/types/automation';

interface TriggerConfigProps {
  /** Existing trigger to edit (omit for create) */
  trigger?: EventTrigger;
  /** Available cron jobs to link */
  jobs: CronJob[];
  onChange: (input: EventTriggerCreateInput) => void;
}

// Mirror of GatewayEventType enum values (kept in sync with electron/gateway/protocol.ts)
const GATEWAY_EVENT_OPTIONS: { label: string; value: string }[] = [
  { label: 'Any', value: '' },
  { label: 'Message Received', value: 'chat.message_received' },
  { label: 'Message Sent', value: 'chat.message_sent' },
  { label: 'Tool Call Completed', value: 'tool.call_completed' },
  { label: 'Tool Call Started', value: 'tool.call_started' },
  { label: 'Channel Status Changed', value: 'channel.status_changed' },
];

export function TriggerConfig({ trigger, jobs, onChange }: TriggerConfigProps) {
  const { t } = useTranslation('cron');

  const [source, setSource] = useState<TriggerSource>(trigger?.source ?? 'gateway');
  const [jobId, setJobId] = useState(trigger?.jobId ?? (jobs[0]?.id ?? ''));
  const [filter, setFilter] = useState<EventFilter>(trigger?.filter ?? {});
  const [debounceMs, setDebounceMs] = useState(trigger?.debounceMs ?? 3000);
  const [enabled, setEnabled] = useState(trigger?.enabled ?? true);

  const emit = (
    newSource: TriggerSource,
    newJobId: string,
    newFilter: EventFilter,
    newDebounce: number,
    newEnabled: boolean,
  ) => {
    onChange({
      jobId: newJobId,
      source: newSource,
      filter: newFilter,
      debounceMs: newDebounce,
      enabled: newEnabled,
    });
  };

  const handleSource = (v: TriggerSource) => {
    setSource(v);
    setFilter({});
    emit(v, jobId, {}, debounceMs, enabled);
  };

  const handleFilter = (partial: Partial<EventFilter>) => {
    const next = { ...filter, ...partial };
    setFilter(next);
    emit(source, jobId, next, debounceMs, enabled);
  };

  const handleJobId = (v: string) => {
    setJobId(v);
    emit(source, v, filter, debounceMs, enabled);
  };

  const handleDebounce = (v: number) => {
    setDebounceMs(v);
    emit(source, jobId, filter, v, enabled);
  };

  const debounceSeconds = Math.round(debounceMs / 1000);

  return (
    <div className="space-y-4">
      {/* Source picker */}
      <div className="space-y-2">
        <Label>{t('trigger.source')}</Label>
        <Select value={source} onChange={(e) => handleSource(e.target.value as TriggerSource)}>
          <option value="gateway">{t('trigger.sourceGateway')}</option>
          <option value="file">{t('trigger.sourceFile')}</option>
          <option value="job_completion">{t('trigger.sourceJobCompletion')}</option>
        </Select>
      </div>

      {/* Per-source filter fields */}
      {source === 'gateway' && (
        <>
          <div className="space-y-2">
            <Label>{t('trigger.filter.eventType')}</Label>
            <Select
              value={filter.eventType ?? ''}
              onChange={(e) => handleFilter({ eventType: e.target.value || undefined })}
            >
              {GATEWAY_EVENT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label>{t('trigger.filter.channelId')}</Label>
            <Input
              placeholder={t('trigger.filter.channelIdPlaceholder')}
              value={filter.channelId ?? ''}
              onChange={(e) => handleFilter({ channelId: e.target.value || undefined })}
            />
          </div>
          <div className="space-y-2">
            <Label>{t('trigger.filter.pattern')}</Label>
            <Input
              placeholder={t('trigger.filter.patternPlaceholder')}
              value={filter.pattern ?? ''}
              onChange={(e) => handleFilter({ pattern: e.target.value || undefined })}
            />
          </div>
        </>
      )}

      {source === 'file' && (
        <>
          <div className="space-y-2">
            <Label>{t('trigger.filter.filePath')}</Label>
            <Input
              placeholder={t('trigger.filter.filePathPlaceholder')}
              value={filter.pattern ?? ''}
              onChange={(e) => handleFilter({ pattern: e.target.value || undefined })}
            />
            <p className="text-xs text-muted-foreground">{t('trigger.filter.filePathDesc')}</p>
          </div>
        </>
      )}

      {source === 'job_completion' && (
        <>
          <div className="space-y-2">
            <Label>{t('trigger.filter.watchedJob')}</Label>
            <Select
              value={filter.jobId ?? ''}
              onChange={(e) => handleFilter({ jobId: e.target.value || undefined })}
            >
              <option value="">{t('trigger.filter.anyJob')}</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label>{t('trigger.filter.statusMatch')}</Label>
            <Select
              value={filter.statusMatch ?? 'any'}
              onChange={(e) => handleFilter({ statusMatch: e.target.value === 'any' ? undefined : e.target.value })}
            >
              <option value="any">{t('trigger.filter.statusAny')}</option>
              <option value="ok">{t('trigger.filter.statusOk')}</option>
              <option value="error">{t('trigger.filter.statusError')}</option>
            </Select>
          </div>
        </>
      )}

      {/* Linked job to execute */}
      <div className="space-y-2">
        <Label>{t('trigger.filter.linkedJob')}</Label>
        <Select value={jobId} onChange={(e) => handleJobId(e.target.value)}>
          {jobs.map((j) => (
            <option key={j.id} value={j.id}>
              {j.name}
            </option>
          ))}
        </Select>
        <p className="text-xs text-muted-foreground">{t('trigger.filter.linkedJobDesc')}</p>
      </div>

      {/* Debounce slider */}
      <div className="space-y-2">
        <Label>
          {t('trigger.debounce')}{' '}
          <span className="text-muted-foreground font-normal">
            ({debounceSeconds === 0 ? t('trigger.debounceOff') : `${debounceSeconds}s`})
          </span>
        </Label>
        <input
          type="range"
          min={0}
          max={60}
          step={1}
          value={debounceSeconds}
          onChange={(e) => handleDebounce(parseInt(e.target.value, 10) * 1000)}
          className="w-full accent-primary"
        />
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>{t('trigger.debounceOff')}</span>
          <span>60s</span>
        </div>
      </div>

      {/* Enabled */}
      <div className="flex items-center gap-3">
        <input
          id="trigger-enabled"
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            setEnabled(e.target.checked);
            emit(source, jobId, filter, debounceMs, e.target.checked);
          }}
          className="h-4 w-4 accent-primary"
        />
        <Label htmlFor="trigger-enabled" className="cursor-pointer">
          {t('trigger.enabled')}
        </Label>
      </div>
    </div>
  );
}
