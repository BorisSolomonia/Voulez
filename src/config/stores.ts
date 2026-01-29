import { StoreConfig } from '../types';
import dotenv from 'dotenv';

dotenv.config();

const storeList = (process.env.WOLT_STORES || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const parseBoolean = (value: string | undefined, fallback: boolean) => {
  if (typeof value !== 'string') {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
};

const resolveStoreName = (id: number) => {
  return process.env[`STORE_${id}_NAME`] || `Store ${id}`;
};

const resolveStoreApiBase = (id: number) => {
  return process.env[`STORE_${id}_WOLT_API_BASE`] || undefined;
};

const buildStoreConfig = (rawId: string): StoreConfig | null => {
  const id = parseInt(rawId, 10);
  if (!Number.isFinite(id)) {
    console.warn(`[Config] Invalid store id "${rawId}" in WOLT_STORES. Skipping.`);
    return null;
  }

  const store: StoreConfig = {
    id,
    name: resolveStoreName(id),
    woltVenueId: process.env[`WOLT_VENUE_ID_${id}`] || process.env[`STORE_${id}_WOLT_VENUE_ID`] || '',
    woltUsername: process.env[`WOLT_USER_${id}`] || process.env[`STORE_${id}_WOLT_USER`],
    woltPassword: process.env[`WOLT_PASS_${id}`] || process.env[`STORE_${id}_WOLT_PASS`],
    woltApiUrl: resolveStoreApiBase(id),
    enabled: parseBoolean(process.env[`STORE_${id}_ENABLED`], true)
  };

  return store;
};

// Build store list dynamically from environment variables
export const stores: StoreConfig[] = storeList
  .map(buildStoreConfig)
  .filter((store): store is StoreConfig => store !== null);

// IMPORTANT: All credentials must be provided via environment variables
// Never commit actual credentials to the repository
export const FINA_API_URL = (process.env.FINA_API_URL || '').trim();
export const FINA_LOGIN = (process.env.FINA_LOGIN || '').trim();
export const FINA_PASSWORD = (process.env.FINA_PASSWORD || '').trim();
export const WOLT_API_BASE = (process.env.WOLT_API_BASE || 'https://pos-integration-service.wolt.com/venues').trim();

// Validation function to check if all required env vars are set
export function validateEnvironment(): { valid: boolean; missing: string[] } {
  const required = [
    { name: 'FINA_API_URL', value: FINA_API_URL },
    { name: 'FINA_LOGIN', value: FINA_LOGIN },
    { name: 'FINA_PASSWORD', value: FINA_PASSWORD },
    { name: 'WOLT_STORES', value: process.env.WOLT_STORES }
  ];

  const missing: string[] = required.filter(r => !r.value).map(r => r.name);

  for (const store of stores) {
    if (!store.enabled) {
      continue;
    }
    if (!store.woltVenueId) {
      missing.push(`WOLT_VENUE_ID_${store.id}`);
    }
    if (!store.woltUsername) {
      missing.push(`WOLT_USER_${store.id}`);
    }
    if (!store.woltPassword) {
      missing.push(`WOLT_PASS_${store.id}`);
    }
  }

  return { valid: missing.length === 0, missing };
}
