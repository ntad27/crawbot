/**
 * Cookie-based Auth Checker
 *
 * Checks whether a WebAuth provider has valid session cookies
 * using Electron's session.cookies.get() API.
 * No WebContentsView needed — reads cookies directly from the session partition.
 */

import { session } from 'electron';

interface CookieAuthSpec {
  partition: string;
  domain: string;
  cookieNames: string[]; // at least one must exist with non-empty value
}

const AUTH_SPECS: Record<string, CookieAuthSpec> = {
  'claude-web': {
    partition: 'persist:webauth-claude',
    domain: '.claude.ai',
    cookieNames: ['sessionKey'],
  },
  'deepseek-web': {
    partition: 'persist:webauth-deepseek',
    domain: '.deepseek.com',
    cookieNames: ['ds_session_id', 'token'],
  },
  'chatgpt-web': {
    partition: 'persist:webauth-chatgpt',
    domain: '.chatgpt.com',
    cookieNames: ['__Secure-next-auth.session-token'],
  },
  'gemini-web': {
    partition: 'persist:webauth-gemini',
    domain: '.google.com',
    cookieNames: ['__Secure-1PSID', 'SID'],
  },
  'grok-web': {
    partition: 'persist:webauth-grok',
    domain: '.grok.com',
    cookieNames: ['auth_token'],
  },
  'qwen-intl-web': {
    partition: 'persist:webauth-qwen-intl',
    domain: '.qwen.ai',
    cookieNames: ['ctoken'],
  },
  'qwen-china-web': {
    partition: 'persist:webauth-qwen-china',
    domain: '.aliyun.com',
    cookieNames: ['login_aliyunid_ticket'],
  },
  'kimi-web': {
    partition: 'persist:webauth-kimi',
    domain: '.moonshot.cn',
    cookieNames: ['kimi-auth'],
  },
  'doubao-web': {
    partition: 'persist:webauth-doubao',
    domain: '.doubao.com',
    cookieNames: ['sessionid'],
  },
  'glm-china-web': {
    partition: 'persist:webauth-glm-china',
    domain: '.chatglm.cn',
    cookieNames: ['chatglm_token'],
  },
  'glm-intl-web': {
    partition: 'persist:webauth-glm-intl',
    domain: '.glm.ai',
    cookieNames: ['chatglm_token'],
  },
  'manus-api': {
    partition: 'persist:webauth-manus',
    domain: '.manus.im',
    cookieNames: ['session'],
  },
};

export async function checkProviderAuth(
  providerId: string,
): Promise<{ authenticated: boolean }> {
  const spec = AUTH_SPECS[providerId];
  if (!spec) return { authenticated: false };

  try {
    const ses = session.fromPartition(spec.partition);
    const cookies = await ses.cookies.get({ domain: spec.domain });
    const hasAuth = spec.cookieNames.some((name) =>
      cookies.some((c) => c.name === name && c.value.length > 5),
    );
    return { authenticated: hasAuth };
  } catch {
    return { authenticated: false };
  }
}

export function getAuthSpec(
  providerId: string,
): CookieAuthSpec | undefined {
  return AUTH_SPECS[providerId];
}
