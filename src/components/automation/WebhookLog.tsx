/**
 * WebhookLog Component
 * Table view of webhook request log entries with expandable rows.
 */
import { useEffect, useState } from 'react';
import { Loader2, ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWebhookStore } from '@/stores/webhook';
import type { WebhookLogEntry } from '@/types/webhook';
import { useTranslation } from 'react-i18next';

interface WebhookLogProps {
  webhookId: string;
}

function StatusBadge({ code }: { code: number }) {
  const isSuccess = code >= 200 && code < 300;
  const isClientErr = code >= 400 && code < 500;
  const isServerErr = code >= 500;

  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium',
        isSuccess && 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
        isClientErr && 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
        isServerErr && 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
        !isSuccess && !isClientErr && !isServerErr && 'bg-muted text-muted-foreground',
      )}
    >
      {code}
    </span>
  );
}

interface LogRowProps {
  entry: WebhookLogEntry;
}

function LogRow({ entry }: LogRowProps) {
  const [expanded, setExpanded] = useState(false);
  const { t } = useTranslation('cron');

  return (
    <>
      <tr
        className="border-b hover:bg-muted/30 cursor-pointer"
        onClick={() => setExpanded((v) => !v)}
      >
        <td className="py-2 pr-3 text-muted-foreground text-xs whitespace-nowrap">
          {new Date(entry.timestamp).toLocaleString()}
        </td>
        <td className="py-2 pr-3">
          <StatusBadge code={entry.statusCode} />
        </td>
        <td className="py-2 pr-3 text-xs text-muted-foreground">{entry.ip}</td>
        <td className="py-2 pr-3 text-xs text-muted-foreground max-w-[200px] truncate">
          {entry.payloadPreview || '—'}
        </td>
        <td className="py-2 pr-3 text-xs text-muted-foreground">{entry.processingMs}ms</td>
        <td className="py-2">
          {expanded ? (
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="bg-muted/20">
          <td colSpan={6} className="px-3 py-3">
            <div className="space-y-1 text-xs font-mono">
              <div>
                <span className="text-muted-foreground">{t('webhook.log.requestId')}: </span>
                {entry.requestId}
              </div>
              <div>
                <span className="text-muted-foreground">{t('webhook.log.payload')}: </span>
                {entry.payloadPreview || '—'}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export function WebhookLog({ webhookId }: WebhookLogProps) {
  const { logs, fetchLogs } = useWebhookStore();
  const [loading, setLoading] = useState(true);
  const { t } = useTranslation('cron');

  const entries: WebhookLogEntry[] = logs[webhookId] ?? [];

  useEffect(() => {
    let cancelled = false;
    fetchLogs(webhookId).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [webhookId, fetchLogs]);

  if (loading) {
    return (
      <div className="flex justify-center py-4">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-2 text-center">{t('webhook.log.empty')}</p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50 text-muted-foreground text-xs">
            <th className="text-left px-3 py-2 font-medium">{t('webhook.log.time')}</th>
            <th className="text-left px-3 py-2 font-medium">{t('webhook.log.status')}</th>
            <th className="text-left px-3 py-2 font-medium">{t('webhook.log.ip')}</th>
            <th className="text-left px-3 py-2 font-medium">{t('webhook.log.payload')}</th>
            <th className="text-left px-3 py-2 font-medium">{t('webhook.log.duration')}</th>
            <th className="w-6 px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <LogRow key={entry.requestId} entry={entry} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
