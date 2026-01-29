export interface FinaInventoryItem {
  id: number;
  rest: number;
  store_id: number;
}

export interface FinaProductField {
  field: string;
  value: string;
}

export interface FinaProductDetail {
  id: number;
  title: string;
  price: number;
  add_fields: FinaProductField[];
}

export interface WoltInventoryItem {
  sku: string;
  inventory: number;
}

export interface WoltInventoryUpdatePayload {
  data: WoltInventoryItem[];
}

export interface WoltItemUpdate {
  sku: string;
  enabled?: boolean;
  price?: number;
  discounted_price?: number;
  vat_percentage?: number;
}

export interface WoltItemUpdatePayload {
  data: WoltItemUpdate[];
}

export interface SyncState {
  [woltId: string]: {
    quantity: number;
    enabled: boolean;
    price?: number;
    lastSeen: number; // timestamp
  };
}

export interface StoreConfig {
  id: number; // Fina Store ID
  name: string;
  woltVenueId: string; // Wolt Venue ID
  woltUsername?: string; // Basic Auth User
  woltPassword?: string; // Basic Auth Pass
  woltApiUrl?: string; // Optional: Override API Base URL (e.g. for testing)
  enabled: boolean;
}

export interface SyncResult {
  success: boolean;
  totalProcessed: number;
  batchesFailed: number;
  errors: string[];
}
