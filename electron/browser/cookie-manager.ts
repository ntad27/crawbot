/**
 * Cookie Manager — CRUD operations on Electron session cookies
 */

import { session } from 'electron';
import { logger } from '../utils/logger';

const LOG_TAG = '[CookieManager]';

export interface CookieData {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expirationDate?: number;
}

/**
 * Get cookies for a URL from a specific session partition
 */
export async function getCookies(
  partition: string,
  url: string
): Promise<Electron.Cookie[]> {
  try {
    const ses = session.fromPartition(partition);
    return await ses.cookies.get({ url });
  } catch (err) {
    logger.error(`${LOG_TAG} getCookies failed:`, err);
    return [];
  }
}

/**
 * Remove a specific cookie by URL and name
 */
export async function removeCookie(
  partition: string,
  url: string,
  name: string
): Promise<void> {
  try {
    const ses = session.fromPartition(partition);
    await ses.cookies.remove(url, name);
  } catch (err) {
    logger.error(`${LOG_TAG} removeCookie failed:`, err);
  }
}

/**
 * Clear all cookies and storage data for a partition
 */
export async function clearPartition(partition: string): Promise<void> {
  try {
    const ses = session.fromPartition(partition);
    await ses.clearStorageData();
    logger.info(`${LOG_TAG} Cleared all data for partition: ${partition}`);
  } catch (err) {
    logger.error(`${LOG_TAG} clearPartition failed:`, err);
  }
}

/**
 * Export all cookies from a partition as JSON
 */
export async function exportCookies(partition: string): Promise<CookieData[]> {
  try {
    const ses = session.fromPartition(partition);
    const cookies = await ses.cookies.get({});
    return cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain || '',
      path: c.path || '/',
      secure: c.secure || false,
      httpOnly: c.httpOnly || false,
      expirationDate: c.expirationDate,
    }));
  } catch (err) {
    logger.error(`${LOG_TAG} exportCookies failed:`, err);
    return [];
  }
}

/**
 * Import cookies into a partition from JSON array
 */
export async function importCookies(
  partition: string,
  cookies: CookieData[]
): Promise<number> {
  const ses = session.fromPartition(partition);
  let imported = 0;

  for (const cookie of cookies) {
    try {
      const url = `http${cookie.secure ? 's' : ''}://${cookie.domain.replace(/^\./, '')}${cookie.path}`;
      await ses.cookies.set({
        url,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        expirationDate: cookie.expirationDate,
      });
      imported++;
    } catch (err) {
      logger.warn(`${LOG_TAG} Failed to import cookie ${cookie.name}:`, err);
    }
  }

  logger.info(`${LOG_TAG} Imported ${imported}/${cookies.length} cookies to ${partition}`);
  return imported;
}
