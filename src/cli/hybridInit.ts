import { Command } from 'commander';
import { stores } from '../config/stores';
import { HybridSyncOrchestrator } from '../core/hybridSync';
import { logger } from '../utils/logger';
import chalk from 'chalk';

export function registerHybridInitCommand(program: Command): void {
  program
    .command('hybrid-init')
    .description('Initialize hybrid sync for a store (Solution 5)')
    .requiredOption('-s, --store <id>', 'Store ID to initialize')
    .action(async (options) => {
      const storeId = parseInt(options.store, 10);
      const store = stores.find(s => s.id === storeId);

      if (!store) {
        console.error(chalk.red(`Store ${storeId} not found in configuration`));
        process.exit(1);
      }

      console.log(chalk.bold.cyan('\n╔═══════════════════════════════════════════════════════════╗'));
      console.log(chalk.bold.cyan('║  WOLT HYBRID SYNC - SOLUTION 5 INITIALIZATION            ║'));
      console.log(chalk.bold.cyan('╚═══════════════════════════════════════════════════════════╝\n'));

      console.log(chalk.yellow(`Store: ${store.name} (ID: ${store.id})`));
      console.log(chalk.yellow(`Venue: ${store.woltVenueId}\n`));

      try {
        const orchestrator = new HybridSyncOrchestrator();
        const status = await orchestrator.initialize(store);

        console.log(chalk.bold.green('\n✓ INITIALIZATION COMPLETE\n'));
        console.log(chalk.cyan('Status Summary:'));
        console.log(`  • Bootstrap: ${status.bootstrapComplete ? chalk.green('✓') : chalk.red('✗')}`);
        console.log(`  • Introspection: ${status.introspectionComplete ? chalk.green('✓') : chalk.red('✗')} (${status.introspectionItemsFound} items found)`);
        console.log(`  • Priority Sync: ${status.prioritySyncComplete ? chalk.green('✓') : chalk.red('✗')} (${status.priorityItemsSynced} items)`);
        console.log(`  • Background Worker: ${status.backgroundWorkerRunning ? chalk.green('Running') : chalk.yellow('Not started')}`);

        console.log(chalk.bold.cyan('\nNext Steps:'));
        console.log(chalk.white('  1. Start the sync service: npm start'));
        console.log(chalk.white('  2. Monitor health: curl http://localhost:3000/health'));
        console.log(chalk.white('  3. Check progress: curl http://localhost:3000/metrics/store/' + storeId));
        console.log(chalk.white('  4. Background worker will sync ~500 items/day automatically\n'));

      } catch (error: any) {
        console.error(chalk.red('\n✗ INITIALIZATION FAILED\n'));
        console.error(chalk.red(error.message));
        logger.error(error);
        process.exit(1);
      }
    });
}
