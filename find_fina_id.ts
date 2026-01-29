
import path from 'path';
import dotenv from 'dotenv';

// 1. Load Config FIRST
dotenv.config({ path: path.join(__dirname, '.env') });

// 2. Then Import Modules
import { FinaAdapter } from './src/adapters/fina';
import { logger } from './src/utils/logger';

async function findId() {
    const targetSku = 'CC021C08';
    const fina = new FinaAdapter();
    const stores = (process.env.WOLT_STORES || '').split(',').map(s => parseInt(s.trim()));
    
    console.log(`Searching for Fina ID matching Wolt SKU: ${targetSku}...`);

    for (const storeId of stores) {
        try {
            console.log(`Checking Store ${storeId}...`);
            // 1. Get Inventory (Rest)
            const { items } = await fina.getInventory(storeId);
            
            // Create a map of ID -> Rest for easy lookup
            const stockMap = new Map<number, number>();
            items.forEach(i => stockMap.set(i.id, i.rest));

            const ids = items.map(i => i.id);
            console.log(`Store ${storeId} has ${ids.length} products. Fetching details...`);
            
            // 2. Fetch details in chunks to find the SKU
            const { products } = await fina.getProductDetails(ids);
            
            let found = false;
            for (const product of products) {
                const woltField = product.add_fields?.find(f => f.field === 'usr_column_514');
                
                // Check for exact match
                if (woltField && woltField.value === targetSku) {
                    const currentRest = stockMap.get(product.id);
                    console.log('-----------------------------------');
                    console.log('MATCH FOUND!');
                    console.log(`Fina Product ID: ${product.id}`);
                    console.log(`Product Name:    ${product.title}`);
                    console.log(`Wolt SKU:        ${targetSku}`);
                    console.log(`Current Stock (in Fina): ${currentRest}`);
                    console.log(`Store ID:        ${storeId}`);
                    console.log('-----------------------------------');
                    found = true;
                }
            }
            if (!found) console.log(`SKU ${targetSku} not found in Store ${storeId}.`);

        } catch (e: any) {
            console.error(`Error searching store ${storeId}: ${e.message}`);
        }
    }
}

findId();