
import { WoltAdapter } from './src/adapters/wolt';
import { stores } from './src/config/stores';
import { logger } from './src/utils/logger';

// SKU to disable
const TARGET_SKU = 'CC021C08';
const STORE_ID = 10;

async function disableItem() {
  const store = stores.find(s => s.id === STORE_ID);
  if (!store) {
    console.error(`Store ${STORE_ID} not found`);
    process.exit(1);
  }

  const wolt = new WoltAdapter();
  console.log(`Disabling SKU ${TARGET_SKU} on Store ${STORE_ID} (${store.woltVenueId})...`);

  // Payload to disable item
  const payload = {
    data: [
      {
        sku: TARGET_SKU,
        enabled: false,
        price: 0 // Optional, but good practice to zero out if disabling
      }
    ]
  };

  try {
    // 1. Disable via Items API
    console.log('Sending Item Update (Disable)...');
    await wolt.updateItems(store.woltVenueId, payload, store.woltUsername, store.woltPassword, store.woltApiUrl);
    console.log('✅ Item disabled successfully.');

    // 2. Zero inventory via Inventory API
    console.log('Sending Inventory Update (Zero Stock)...');
    const inventoryPayload = {
      data: [
        {
          sku: TARGET_SKU,
          inventory: 0
        }
      ]
    };
    await wolt.updateInventory(store.woltVenueId, inventoryPayload, store.woltUsername, store.woltPassword, store.woltApiUrl);
    console.log('✅ Inventory zeroed successfully.');

  } catch (error: any) {
    console.error('❌ Failed to disable item:');
    if (error.response) {
      console.error(`Status: ${error.response.status}`);
      console.error(`Data: ${JSON.stringify(error.response.data, null, 2)}`);
    } else {
      console.error(error.message);
    }
  }
}

disableItem();
