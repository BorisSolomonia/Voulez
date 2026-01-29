#!/usr/bin/env node
import { Command } from 'commander';
import { stores } from '../config/stores';
import { SyncEngine } from '../core/sync';
import { logger } from '../utils/logger';
import { registerHybridInitCommand } from './hybridInit';

const program = new Command();

program
  .name('wolt-cli')
  .description('CLI for Wolt Sync System')
  .version('1.0.0');

program
  .command('sync')
  .description('Run a manual sync for a specific store (delta sync by default)')
  .requiredOption('-s, --store <id>', 'Store ID to sync (e.g., 10)')
  .option('-d, --dry-run', 'Run without sending data to Wolt', false)
  .option('-l, --limit <n>', 'Limit number of availability/inventory updates (for testing)', '0')
  .option('--force-full', 'Force full sync (send all items, not just changes)', false)
  .action(async (options) => {
    const storeId = parseInt(options.store, 10);
    const store = stores.find(s => s.id === storeId);

    if (!store) {
      console.error(`Store ${storeId} not found in configuration.`);
      process.exit(1);
    }

    const limit = parseInt(options.limit, 10) || 0;

    const engine = new SyncEngine();
    try {
      await engine.runWithOptions(store, {
        dryRun: options.dryRun,
        limit: limit > 0 ? limit : undefined,
        forceFullSync: options.forceFull
      });
      console.log('Sync completed successfully.');
    } catch (error: any) {
      console.error('Sync failed:', error.message);
      process.exit(1);
    }
  });

program
  .command('bootstrap')
  .description('Create initial state from Fina data WITHOUT sending to Wolt (run this first for new stores)')
  .requiredOption('-s, --store <id>', 'Store ID to bootstrap')
  .option('-a, --all', 'Bootstrap all enabled stores', false)
  .action(async (options) => {
    const engine = new SyncEngine();

    if (options.all) {
      console.log('Bootstrapping all enabled stores...');
      for (const store of stores.filter(s => s.enabled)) {
        try {
          console.log(`\nBootstrapping Store ${store.id} (${store.name})...`);
          await engine.runWithOptions(store, { bootstrapState: true });
          console.log(`Store ${store.id} bootstrapped successfully.`);
        } catch (error: any) {
          console.error(`Store ${store.id} bootstrap failed:`, error.message);
        }
      }
      console.log('\nBootstrap complete. Run "sync" to send only changes to Wolt.');
    } else {
      const storeId = parseInt(options.store, 10);
      const store = stores.find(s => s.id === storeId);

      if (!store) {
        console.error(`Store ${storeId} not found in configuration.`);
        process.exit(1);
      }

      try {
        await engine.runWithOptions(store, { bootstrapState: true });
        console.log('Bootstrap completed successfully. Run "sync" to send only changes to Wolt.');
      } catch (error: any) {
        console.error('Bootstrap failed:', error.message);
        process.exit(1);
      }
    }
  });

program
  .command('test-venue')
  .description('Run sync against a test venue using real Fina data from a source store')
  .requiredOption('--source-store <id>', 'Fina Store ID to fetch data from')
  .requiredOption('--venue <id>', 'Target Test Venue ID')
  .option('--user <user>', 'Test Venue Username')
  .option('--pass <pass>', 'Test Venue Password')
  .option('--api-url <url>', 'Wolt API Base URL', 'https://pos-integration-service.development.dev.woltapi.com/venues')
  .option('--limit <n>', 'Limit number of items to sync (for testing)', '50')
  .option('-d, --dry-run', 'Dry run', false)
  .action(async (options) => {
    const sourceStoreId = parseInt(options.sourceStore, 10);
    const sourceStore = stores.find(s => s.id === sourceStoreId);

    if (!sourceStore) {
        console.error(`Source Store ${sourceStoreId} not found in configuration.`);
        process.exit(1);
    }

    // Load credentials from Env if not provided in args (Golden Solution)
    let woltUsername = options.user || process.env.TEST_WOLT_USER;
    let woltPassword = options.pass || process.env.TEST_WOLT_PASS;
    let woltVenueId = options.venue || process.env.TEST_WOLT_VENUE_ID;

    if (!woltUsername || !woltPassword) {
       console.error('Error: Missing Test Venue Credentials. Provide via --user/--pass or TEST_WOLT_USER/TEST_WOLT_PASS env vars.');
       process.exit(1);
    }

    // SANITIZATION: Trim whitespace (Fixes copy-paste errors)
    woltUsername = woltUsername.trim();
    woltPassword = woltPassword.trim();
    woltVenueId = woltVenueId.trim();

    // VALIDATION: Check for common issues
    const passLen = woltPassword.length;
    if (woltPassword.includes(' ')) {
        console.error(`❌ CRITICAL ERROR: Password contains spaces! (Length: ${passLen})`);
        console.error(`   Received: "${woltPassword.substring(0, 5)}...${woltPassword.slice(-5)}"`);
        console.error(`   Please check your command line arguments or quotes.`);
        process.exit(1);
    }

    if (passLen !== 64) {
        console.warn(`⚠️  WARNING: Password length is ${passLen} (Expected 64 for SHA-256 hash). Authentication may fail.`);
    }

    const passStart = woltPassword.substring(0, 2);
    const passEnd = woltPassword.substring(passLen - 2);

    console.log(`Starting Test Sync from Fina Store ${sourceStoreId} -> Wolt Test Venue ${woltVenueId}`);
    console.log(`Debug Creds: User=${woltUsername}, PassLen=${passLen}, PassMask=${passStart}...${passEnd}`);

    // Create a temporary config using the source store's Fina ID but the Test Venue's Wolt Creds
    const testConfig = {
        ...sourceStore,
        woltVenueId: woltVenueId,
        woltUsername: woltUsername,
        woltPassword: woltPassword,
        woltApiUrl: options.apiUrl,
        name: `TEST-VENUE-SYNC (Source: ${sourceStore.name})`
    };

    const engine = new SyncEngine();
    try {
      await engine.run(testConfig, options.dryRun, parseInt(options.limit, 10));
      console.log('Test Sync completed successfully.');
    } catch (error: any) {
      console.error('Test Sync failed:', error.message);
      process.exit(1);
    }
  });

program
  .command('list-stores')
  .description('List all configured stores')
  .action(() => {
    console.table(stores.map(s => ({ id: s.id, name: s.name, enabled: s.enabled })));
  });

// Register Hybrid Sync command (Solution 5)
registerHybridInitCommand(program);

program.parse(process.argv);
