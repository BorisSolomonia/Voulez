import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StateManager } from '../../src/core/state';
import fs from 'fs-extra';
import path from 'path';

// Mock fs-extra
vi.mock('fs-extra', () => ({
  default: {
    ensureDirSync: vi.fn(),
    pathExists: vi.fn(),
    readJson: vi.fn(),
    writeJson: vi.fn(),
    writeFile: vi.fn(),
    move: vi.fn(),
    copy: vi.fn(),
    remove: vi.fn(),
  },
  ensureDirSync: vi.fn(),
  pathExists: vi.fn(),
  readJson: vi.fn(),
  writeJson: vi.fn(),
  writeFile: vi.fn(),
  move: vi.fn(),
  copy: vi.fn(),
  remove: vi.fn(),
}));

describe('StateManager', () => {
  let stateManager: StateManager;

  beforeEach(() => {
    vi.clearAllMocks();
    stateManager = new StateManager();
  });

  describe('loadState', () => {
    it('should return empty state when file does not exist', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(false as never);

      const state = await stateManager.loadState(1);

      expect(state).toEqual({});
    });

    it('should load existing state from file', async () => {
      const mockState = {
        'WOLT-001': { quantity: 10, enabled: true, lastSeen: Date.now() },
        'WOLT-002': { quantity: 0, enabled: false, lastSeen: Date.now() },
      };

      vi.mocked(fs.pathExists).mockResolvedValue(true as never);
      vi.mocked(fs.readJson).mockResolvedValue(mockState as never);

      const state = await stateManager.loadState(1);

      expect(state).toEqual(mockState);
    });

    it('should return empty state on read error', async () => {
      vi.mocked(fs.pathExists)
        .mockResolvedValueOnce(true as never)
        .mockResolvedValueOnce(false as never);
      vi.mocked(fs.readJson).mockRejectedValue(new Error('Read error') as never);

      const state = await stateManager.loadState(1);

      expect(state).toEqual({});
    });

    it('should fall back to backup state when primary is invalid', async () => {
      const backupState = {
        'WOLT-003': { quantity: 5, enabled: true, lastSeen: Date.now() },
      };

      vi.mocked(fs.pathExists)
        .mockResolvedValueOnce(true as never)
        .mockResolvedValueOnce(true as never);
      vi.mocked(fs.readJson)
        .mockRejectedValueOnce(new Error('Read error') as never)
        .mockResolvedValueOnce(backupState as never);

      const state = await stateManager.loadState(1);

      expect(state).toEqual(backupState);
    });
  });

  describe('saveState', () => {
    it('should save state atomically using temp file', async () => {
      const mockState = {
        'WOLT-001': { quantity: 10, enabled: true, lastSeen: Date.now() },
      };

      vi.mocked(fs.writeJson).mockResolvedValue(undefined as never);
      vi.mocked(fs.move).mockResolvedValue(undefined as never);

      await stateManager.saveState(1, mockState);

      expect(fs.writeJson).toHaveBeenCalled();
      expect(fs.move).toHaveBeenCalled();
    });

    it('should clean up temp file on error', async () => {
      const mockState = {
        'WOLT-001': { quantity: 10, enabled: true, lastSeen: Date.now() },
      };

      vi.mocked(fs.writeJson).mockResolvedValue(undefined as never);
      vi.mocked(fs.move).mockRejectedValue(new Error('Move error') as never);
      vi.mocked(fs.copy).mockRejectedValue(new Error('Copy error') as never);
      vi.mocked(fs.pathExists).mockResolvedValue(true as never);
      vi.mocked(fs.remove).mockResolvedValue(undefined as never);

      await stateManager.saveState(1, mockState);

      expect(fs.remove).toHaveBeenCalled();
    });
  });

  describe('stateExists', () => {
    it('should return true when state file exists', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(true as never);

      const exists = await stateManager.stateExists(1);

      expect(exists).toBe(true);
    });

    it('should return false when state file does not exist', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(false as never);

      const exists = await stateManager.stateExists(1);

      expect(exists).toBe(false);
    });
  });

  describe('deleteState', () => {
    it('should delete existing state file', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(true as never);
      vi.mocked(fs.remove).mockResolvedValue(undefined as never);

      await stateManager.deleteState(1);

      expect(fs.remove).toHaveBeenCalled();
    });

    it('should handle non-existent file gracefully', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(false as never);

      await stateManager.deleteState(1);

      expect(fs.remove).not.toHaveBeenCalled();
    });
  });

  describe('checkpoint methods', () => {
    it('should save and load checkpoints', async () => {
      const checkpointData = {
        completedBatches: 5,
        totalBatches: 10,
        completedProducts: 500,
        timestamp: Date.now(),
      };

      vi.mocked(fs.writeJson).mockResolvedValue(undefined as never);
      vi.mocked(fs.move).mockResolvedValue(undefined as never);
      vi.mocked(fs.pathExists).mockResolvedValue(true as never);
      vi.mocked(fs.readJson).mockResolvedValue(checkpointData as never);

      await stateManager.saveCheckpoint(1, checkpointData);
      const loaded = await stateManager.loadCheckpoint(1);

      expect(loaded).toEqual(checkpointData);
    });

    it('should return null when checkpoint does not exist', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(false as never);

      const checkpoint = await stateManager.loadCheckpoint(1);

      expect(checkpoint).toBeNull();
    });
  });
});
