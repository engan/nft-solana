import bs58 from 'bs58';
import fs from 'fs';

const walletPath = 'DIN_SOLANA_WALLET_PATH_HER';

if (!fs.existsSync(walletPath)) {
  console.error(`Error: Keypair file not found at path: ${walletPath}`);
  process.exit(1);
}

const keypair = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
const secretKey = bs58.encode(Uint8Array.from(keypair.slice(0, 32)));

console.log(`Base58 Private Key: ${secretKey}`);
