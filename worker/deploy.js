/**
 * AttestOS - Cloudflare Worker Automated Edge Deployer
 * 
 * Account ID: ad5b6ab933ddf4c5ea9a2c49cc3c2c30
 * Deploys worker.js directly via Cloudflare API v4 with zero external CLI dependencies.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// Load environment variables from .env if present (git-ignored)
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const [k, ...v] = line.split('=');
    if (k && v.length) {
      process.env[k.trim()] = v.join('=').trim();
    }
  });
}

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || 'ad5b6ab933ddf4c5ea9a2c49cc3c2c30';
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const SCRIPT_NAME = 'attestos-edge';

async function deployWorker() {
  if (!API_TOKEN) {
    throw new Error('Missing CLOUDFLARE_API_TOKEN. Please set it in your environment or in a local .env file.');
  }

  console.log(`🚀 [AttestOS] Deploying Edge Worker '${SCRIPT_NAME}' to Cloudflare Account: ${ACCOUNT_ID}...`);

  const workerPath = path.join(__dirname, 'worker.js');
  const workerScript = fs.readFileSync(workerPath, 'utf8');

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.cloudflare.com',
      path: `/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${SCRIPT_NAME}`,
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/javascript',
        'User-Agent': 'AttestOS-Deployer/2.0'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.success) {
            console.log(`✅ [AttestOS] Successfully deployed '${SCRIPT_NAME}' to Cloudflare Edge!`);
            console.log(`   Deployment ID: ${parsed.result ? parsed.result.deployment_id : 'live'}`);
            console.log(`   Modified On: ${parsed.result ? parsed.result.modified_on : new Date().toISOString()}`);
            console.log(`   Quota Profile: 2/10th Ultra-Lean Mode Active`);
            resolve(parsed);
          } else {
            console.error(`❌ [AttestOS] Cloudflare Deployment Error:`, parsed.errors);
            reject(new Error(JSON.stringify(parsed.errors)));
          }
        } catch (e) {
          reject(new Error(`Failed to parse Cloudflare API response: ${data}`));
        }
      });
    });

    req.on('error', (err) => {
      console.error(`❌ Request failed:`, err.message);
      reject(err);
    });

    req.write(workerScript);
    req.end();
  });
}

if (require.main === module) {
  deployWorker().catch(err => {
    console.error('Fatal deployment error:', err.message);
    process.exit(1);
  });
}

module.exports = { deployWorker };
