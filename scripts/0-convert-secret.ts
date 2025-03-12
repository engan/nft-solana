import bs58 from 'bs58';
import fs from 'fs';
import os from 'os';

// Velg nettverk her (endre til 'devnet' eller 'mainnet-beta')
const network = 'devnet'; // eller 'mainnet-beta'

// Erstatt dette med din eksporterte secret key fra Phantom
const secretKeyBase58 = 'DIN_SOLANA_SECRET_KEY_HER';

// Dekod secret key fra Base58
const secretKey = bs58.decode(secretKeyBase58);

// Konverter til JSON array
const secretKeyArray = Array.from(secretKey);

// Lag JSON-streng
const jsonArray = JSON.stringify(secretKeyArray);

// Definer filbanen basert på nettverket
const outputPath = `${os.homedir()}/.config/solana/${network}-id.json`;

// Skriv til fil
fs.writeFileSync(outputPath, jsonArray);

console.log(
  `${network}-id.json har blitt oppdatert med din secret key. Path: ${outputPath}`
);