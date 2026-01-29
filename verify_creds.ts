import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const url = process.env.WOLT_TEST_URL;
const username = process.env.WOLT_TEST_USER;
const password = process.env.WOLT_TEST_PASS;

async function testAuth() {
  if (!url || !username || !password) {
    console.error('Missing env vars: set WOLT_TEST_URL, WOLT_TEST_USER, WOLT_TEST_PASS');
    process.exit(1);
  }

  const auth = Buffer.from(`${username}:${password}`).toString('base64');
  console.log(`Testing Auth (PATCH) for ${username} at ${url}`);

  try {
    const response = await axios.patch(url, {
      data: [
        {
           sku: 'TEST-ITEM-123',
           enabled: false
        }
      ]
    }, {
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json;charset=utf-8'
      }
    });
    console.log('Success! Status:', response.status);
    console.log('Response:', response.data);
  } catch (error: any) {
    console.error('Failed!');
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', JSON.stringify(error.response.data));
    } else {
      console.error('Error:', error.message);
    }
  }
}

testAuth();
