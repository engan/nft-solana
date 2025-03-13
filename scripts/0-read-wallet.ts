import bs58 from 'bs58';
import fs from 'fs';
import path from 'path';

// Brukes hvis 0-convert-secret.ts ikke benyttes
// const walletPath = 'DIN_SOLANA_WALLET_PATH_HER';

// Hent nettverk fra miljøvariabel (eller bruk 'devnet' som standard)
const network = process.env.CLUSTER || 'devnet';

// Definer wallet path basert på valgt nettverk
const walletPath = path.resolve(process.cwd(), `wallets/${network}-id.json`);

console.log(`🔍 Leser wallet fra: ${walletPath} (${network})`);

if (!fs.existsSync(walletPath)) {
  console.error(`❌ Feil: Wallet-fil ikke funnet på path: ${walletPath}`);
  process.exit(1);
}

try {
  // Les inn JSON-filen og konverter til en keypair-array
  const keypair = JSON.parse(fs.readFileSync(walletPath, 'utf8'));

  if (!Array.isArray(keypair) || keypair.length < 32) {
    console.error(`❌ Feil: Wallet-filen inneholder ikke en gyldig nøkkel.`);
    process.exit(1);
  }

  // Konverter til Base58
  const secretKey = bs58.encode(Uint8Array.from(keypair.slice(0, 32)));

  // Logg kun en del av nøkkelen for sikkerhet
  console.log(`✅ Base58 Private Key (${network}): ${secretKey.slice(0, 10)}...${secretKey.slice(-10)}`);
} catch (error) {
  console.error(`❌ Feil ved lesing av wallet-filen:`, error);
  process.exit(1);
}