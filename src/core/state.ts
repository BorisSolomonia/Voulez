import fs from 'fs-extra';
import path from 'path';
import { SyncState } from '../types';
import { logger } from '../utils/logger';

const transientRenameErrors = new Set(['EPERM', 'EBUSY', 'EACCES']);

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export interface CheckpointData {
  completedBatches: number;
  totalBatches: number;
  completedProducts: number;
  timestamp: number;
}

export class StateManager {
  private stateDir: string;
  private readonly useDirectWrite: boolean;

  constructor() {
    this.stateDir = path.join(process.cwd(), 'state');
    fs.ensureDirSync(this.stateDir);
    this.useDirectWrite = (process.env.STATE_WRITE_MODE || '').trim().toLowerCase() === 'direct';
  }

  private getStatePath(storeId: number): string {
    return path.join(this.stateDir, `.state-store-${storeId}.json`);
  }

  private getBackupPath(storeId: number): string {
    return path.join(this.stateDir, `.state-store-${storeId}.json.bak`);
  }

  private getCheckpointPath(storeId: number): string {
    return path.join(this.stateDir, `.checkpoint-store-${storeId}.json`);
  }

  private isValidState(data: unknown): data is SyncState {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return false;
    }

    for (const [sku, entry] of Object.entries(data)) {
      if (typeof sku !== 'string' || sku.trim() === '') {
        return false;
      }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return false;
      }
      const stateEntry = entry as Partial<SyncState[string]>;
      if (!Number.isFinite(stateEntry.quantity) || typeof stateEntry.enabled !== 'boolean') {
        return false;
      }
      if (stateEntry.price !== undefined && !Number.isFinite(stateEntry.price)) {
        return false;
      }
      if (stateEntry.lastSeen !== undefined && !Number.isFinite(stateEntry.lastSeen)) {
        return false;
      }
    }

    return true;
  }

  private async readStateFile(filePath: string, storeId: number, label: string): Promise<SyncState | null> {
    try {
      const data = await fs.readJson(filePath);
      if (!this.isValidState(data)) {
        logger.error(`Failed to load ${label} for store ${storeId}: Invalid state format`);
        return null;
      }
      return data;
    } catch (error: any) {
      logger.error(`Failed to load ${label} for store ${storeId}: ${error.message}`);
      return null;
    }
  }

  private async commitTempFile(tempPath: string, filePath: string, label: string): Promise<void> {
    let lastError: any;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await fs.move(tempPath, filePath, { overwrite: true });
        return;
      } catch (error: any) {
        lastError = error;
        if (!transientRenameErrors.has(error?.code)) {
          throw error;
        }
        await sleep(50 * attempt);
      }
    }

    try {
      await fs.copy(tempPath, filePath, { overwrite: true });
      await fs.remove(tempPath);
      logger.warn(`${label} saved using copy fallback after rename failure: ${lastError?.code || lastError?.message}`);
    } catch (error: any) {
      throw lastError || error;
    }
  }

  async loadState(storeId: number): Promise<SyncState> {
    const filePath = this.getStatePath(storeId);
    const primaryExists = await fs.pathExists(filePath);

    if (primaryExists) {
      const primary = await this.readStateFile(filePath, storeId, 'state');
      if (primary) {
        return primary;
      }

      // Primary file exists but is corrupt - try backup
      const backupPath = this.getBackupPath(storeId);
      if (await fs.pathExists(backupPath)) {
        const backup = await this.readStateFile(backupPath, storeId, 'backup state');
        if (backup) {
          logger.warn(`State file corrupt; using backup for store ${storeId}.`);
          return backup;
        }
      }

      // Both primary and backup are corrupt
      logger.error(`State file and backup corrupt for store ${storeId}. Starting fresh.`);
      return {};
    }

    // Primary file doesn't exist - return empty state (triggers full sync)
    logger.info(`No state file found for store ${storeId}. Will run full sync.`);
    return {};
  }

  async saveState(storeId: number, state: SyncState): Promise<void> {
    const filePath = this.getStatePath(storeId);
    const tempPath = `${filePath}.tmp`;
    const backupPath = this.getBackupPath(storeId);

    try {
      if (await fs.pathExists(filePath)) {
        try {
          await fs.copy(filePath, backupPath, { overwrite: true });
        } catch (error: any) {
          logger.warn(`Failed to write state backup for store ${storeId}: ${error.message}`);
        }
      }

      if (this.useDirectWrite) {
        const payload = JSON.stringify(state);
        try {
          await fs.writeFile(tempPath, payload);
          try {
            await fs.copy(tempPath, filePath, { overwrite: true });
          } catch (copyError: any) {
            logger.warn(`State copy fallback failed for store ${storeId}: ${copyError.message}. Writing directly.`);
            await fs.writeFile(filePath, payload);
          }
          logger.debug(`State saved for store ${storeId}`);
        } finally {
          try {
            if (await fs.pathExists(tempPath)) {
              await fs.remove(tempPath);
            }
          } catch {
            // Ignore cleanup errors (temp files are safe to leave behind).
          }
        }
        return;
      }

      // Write to temporary file first
      await fs.writeJson(tempPath, state);

      // Atomic rename (replaces existing file)
      await this.commitTempFile(tempPath, filePath, `State for store ${storeId}`);

      logger.debug(`State saved for store ${storeId}`);
    } catch (error: any) {
      logger.error(`Failed to save state for store ${storeId}: ${error.message}`);

      // Clean up temp file if it exists
      try {
        if (await fs.pathExists(tempPath)) {
          await fs.remove(tempPath);
        }
      } catch (cleanupError) {
        // Ignore cleanup errors
      }
    }
  }

  async stateExists(storeId: number): Promise<boolean> {
    const filePath = this.getStatePath(storeId);
    return await fs.pathExists(filePath);
  }

  async deleteState(storeId: number): Promise<void> {
    const filePath = this.getStatePath(storeId);
    try {
      if (await fs.pathExists(filePath)) {
        await fs.remove(filePath);
        logger.info(`State deleted for store ${storeId}`);
      }
    } catch (error: any) {
      logger.error(`Failed to delete state for store ${storeId}: ${error.message}`);
    }
  }

  // Checkpoint methods for first sync recovery
  async loadCheckpoint(storeId: number): Promise<CheckpointData | null> {
    const filePath = this.getCheckpointPath(storeId);
    if (await fs.pathExists(filePath)) {
      try {
        return await fs.readJson(filePath);
      } catch (error: any) {
        logger.error(`Failed to load checkpoint for store ${storeId}: ${error.message}`);
        return null;
      }
    }
    return null;
  }

  async saveCheckpoint(storeId: number, data: CheckpointData): Promise<void> {
    const filePath = this.getCheckpointPath(storeId);
    const tempPath = `${filePath}.tmp`;

    try {
      if (this.useDirectWrite) {
        await fs.writeFile(filePath, JSON.stringify(data));
        logger.debug(`Checkpoint saved for store ${storeId} (batch ${data.completedBatches}/${data.totalBatches})`);
        return;
      }

      // Write to temporary file first
      await fs.writeJson(tempPath, data);

      // Atomic rename
      await this.commitTempFile(tempPath, filePath, `Checkpoint for store ${storeId}`);

      logger.debug(`Checkpoint saved for store ${storeId} (batch ${data.completedBatches}/${data.totalBatches})`);
    } catch (error: any) {
      logger.error(`Failed to save checkpoint for store ${storeId}: ${error.message}`);

      // Clean up temp file if it exists
      try {
        if (await fs.pathExists(tempPath)) {
          await fs.remove(tempPath);
        }
      } catch (cleanupError) {
        // Ignore cleanup errors
      }
    }
  }

  async deleteCheckpoint(storeId: number): Promise<void> {
    const filePath = this.getCheckpointPath(storeId);
    try {
      if (await fs.pathExists(filePath)) {
        await fs.remove(filePath);
        logger.debug(`Checkpoint deleted for store ${storeId}`);
      }
    } catch (error: any) {
      logger.error(`Failed to delete checkpoint for store ${storeId}: ${error.message}`);
    }
  }
}
