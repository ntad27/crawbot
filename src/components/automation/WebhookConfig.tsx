/**
 * WebhookConfig Component
 * Displays webhook URL, secret management, cURL example, and logs for a cron job.
 */
import { useState, useEffect, useCallback } from 'react';
import {
  Copy,
  Eye,
  EyeOff,
  RefreshCw,
  Trash2,
  Webhook,
  CheckCircle2,
  Loader2,
  AlertCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { useWebhookStore } from '@/stores/webhook';
import { WebhookLog } from './WebhookLog';
import type { WebhookConfig as WebhookConfigType } from '@/types/webhook';
import { useTranslation } from 'react-i18next';

interface WebhookConfigProps {
  jobId: string;
  onClose: () => void;
}

export function WebhookConfig({ jobId, onClose }: WebhookConfigProps) {
  const { t } = useTranslation('cron');
  const {
    webhooks,
    serverConfig,
    fetchWebhooks,
    createWebhook,
    deleteWebhook,
    regenerateSecret,
    toggleWebhook,
    fetchServerConfig,
  } = useWebhookStore();

  const [loading, setLoading] = useState(true);
  const [secretVisible, setSecretVisible] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [creating, setCreating] = useState(false);

  const webhook: WebhookConfigType | undefined = webhooks.find((w) => w.jobId === jobId);
  const port = serverConfig?.port ?? 18790;
  const webhookUrl = webhook ? `http://localhost:${port}/webhooks/${webhook.id}` : '';

  // Load data on mount
  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        await Promise.all([fetchWebhooks(), fetchServerConfig()]);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [fetchWebhooks, fetchServerConfig]);

  const handleCreate = useCallback(async () => {
    setCreating(true);
    try {
      await createWebhook({ jobId });
      toast.success(t('webhook.created'));
    } catch (err) {
      toast.error(String(err));
    } finally {
      setCreating(false);
    }
  }, [createWebhook, jobId, t]);

  const handleDelete = useCallback(async () => {
    if (!webhook) return;
    if (!confirm(t('webhook.deleteConfirm'))) return;
    setDeleting(true);
    try {
      await deleteWebhook(webhook.id);
      toast.success(t('webhook.deleted'));
    } catch (err) {
      toast.error(String(err));
    } finally {
      setDeleting(false);
    }
  }, [deleteWebhook, webhook, t]);

  const handleRegenerate = useCallback(async () => {
    if (!webhook) return;
    if (!confirm(t('webhook.regenerateConfirm'))) return;
    setRegenerating(true);
    try {
      await regenerateSecret(webhook.id);
      toast.success(t('webhook.secretRegenerated'));
    } catch (err) {
      toast.error(String(err));
    } finally {
      setRegenerating(false);
    }
  }, [regenerateSecret, webhook, t]);

  const handleToggle = useCallback(async (enabled: boolean) => {
    if (!webhook) return;
    try {
      await toggleWebhook(webhook.id, enabled);
      toast.success(enabled ? t('webhook.enabled') : t('webhook.disabled'));
    } catch (err) {
      toast.error(String(err));
    }
  }, [toggleWebhook, webhook, t]);

  const copyToClipboard = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} ${t('webhook.copied')}`);
    } catch {
      toast.error(t('webhook.copyFailed'));
    }
  }, [t]);

  const curlExample = webhook
    ? `curl -X POST ${webhookUrl} \\
  -H "Content-Type: application/json" \\
  -H "X-Webhook-Timestamp: $(date +%s)" \\
  -H "X-Webhook-Signature: sha256=$(echo -n \\"$(date +%s).{\\"message\\":\\"Hello\\"}\\" | openssl dgst -sha256 -hmac '${webhook.secret}' | awk '{print $2}')" \\
  -d '{"message": "Hello"}'`
    : '';

  if (loading) {
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <Card className="w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Webhook className="h-5 w-5 text-primary" />
              <CardTitle>{t('webhook.title')}</CardTitle>
            </div>
            <Button variant="ghost" size="sm" onClick={onClose}>
              &times;
            </Button>
          </div>
          <CardDescription>{t('webhook.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {!webhook ? (
            /* No webhook configured — show create button */
            <div className="flex flex-col items-center gap-4 py-8">
              <AlertCircle className="h-10 w-10 text-muted-foreground" />
              <p className="text-sm text-muted-foreground text-center">{t('webhook.noWebhook')}</p>
              <Button onClick={handleCreate} disabled={creating}>
                {creating ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Webhook className="h-4 w-4 mr-2" />
                )}
                {t('webhook.create')}
              </Button>
            </div>
          ) : (
            <>
              {/* Status */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Badge variant={webhook.enabled ? 'success' : 'secondary'}>
                    {webhook.enabled ? t('webhook.active') : t('webhook.inactive')}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {t('webhook.created')}: {new Date(webhook.createdAt).toLocaleDateString()}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Label className="text-sm">{t('webhook.enableLabel')}</Label>
                  <Switch checked={webhook.enabled} onCheckedChange={handleToggle} />
                </div>
              </div>

              {/* Webhook URL */}
              <div className="space-y-2">
                <Label>{t('webhook.url')}</Label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded-md bg-muted px-3 py-2 text-sm font-mono break-all">
                    {webhookUrl}
                  </code>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => copyToClipboard(webhookUrl, t('webhook.url'))}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {/* Secret */}
              <div className="space-y-2">
                <Label>{t('webhook.secret')}</Label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded-md bg-muted px-3 py-2 text-sm font-mono overflow-hidden">
                    {secretVisible ? webhook.secret : '•'.repeat(32)}
                  </code>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => setSecretVisible((v) => !v)}
                  >
                    {secretVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                  {secretVisible && (
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => copyToClipboard(webhook.secret, t('webhook.secret'))}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleRegenerate}
                    disabled={regenerating}
                  >
                    {regenerating ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <RefreshCw className="h-4 w-4 mr-2" />
                    )}
                    {t('webhook.regenerate')}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">{t('webhook.secretDesc')}</p>
              </div>

              {/* Rate limit info */}
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <CheckCircle2 className="h-4 w-4" />
                {t('webhook.rateLimit')}: {webhook.rateLimit ?? 60} {t('webhook.rateLimitUnit')}
              </div>

              {/* cURL Example */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>{t('webhook.curlExample')}</Label>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => copyToClipboard(curlExample, t('webhook.curlExample'))}
                  >
                    <Copy className="h-3 w-3 mr-1" />
                    {t('webhook.copy')}
                  </Button>
                </div>
                <pre className="rounded-md bg-muted p-3 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all">
                  {curlExample}
                </pre>
                <p className="text-xs text-muted-foreground">{t('webhook.curlDesc')}</p>
              </div>

              {/* Logs */}
              <div className="space-y-2">
                <Label>{t('webhook.logs')}</Label>
                <WebhookLog webhookId={webhook.id} />
              </div>

              {/* Delete */}
              <div className="flex justify-end border-t pt-4">
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleDelete}
                  disabled={deleting}
                >
                  {deleting ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4 mr-2" />
                  )}
                  {t('webhook.delete')}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
