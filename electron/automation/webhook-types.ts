/**
 * Webhook / HTTP API types (main process)
 */

export interface WebhookConfig {
  id: string;
  jobId: string;
  secret: string;
  enabled: boolean;
  createdAt: string;
  rateLimit?: number; // requests per minute, default 60
}

export interface WebhookLogEntry {
  timestamp: string;
  webhookId: string;
  ip: string;
  statusCode: number;
  payloadPreview: string; // first 200 chars
  processingMs: number;
  requestId: string;
}

export interface WebhookCreateInput {
  jobId: string;
  rateLimit?: number;
}

export interface HttpServerConfig {
  port: number;
  bindAddress: string; // default '127.0.0.1'
  enabled: boolean;
}
