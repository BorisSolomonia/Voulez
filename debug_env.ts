
import dotenv from 'dotenv';
import path from 'path';

// Explicitly load .env from the current directory
const result = dotenv.config({ path: path.resolve(process.cwd(), '.env') });

if (result.error) {
  console.error("Error loading .env file:", result.error);
}

const url = process.env.FINA_API_URL;

console.log("--- Debugging FINA_API_URL ---");
console.log(`Raw value: '${url}'`);

if (!url) {
  console.error("ERROR: FINA_API_URL is undefined or empty.");
  process.exit(1);
}

console.log(`Length: ${url.length}`);
console.log("Character codes:");
for (let i = 0; i < url.length; i++) {
  console.log(`  [${i}] ${url[i]} -> ${url.charCodeAt(i)}`);
}

try {
  const parsed = new URL(url);
  console.log("URL parsing: SUCCESS");
  console.log(`  Protocol: ${parsed.protocol}`);
  console.log(`  Hostname: ${parsed.hostname}`);
  console.log(`  Port: ${parsed.port}`);
  console.log(`  Path: ${parsed.pathname}`);
} catch (e: any) {
  console.error("URL parsing: FAILED");
  console.error(e.message);
}

import axios from 'axios';
try {
    const client = axios.create({ baseURL: url });
    console.log("Axios creation: SUCCESS");
} catch(e: any) {
    console.error("Axios creation: FAILED");
    console.error(e.message);
}
