import bs58 from 'bs58';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

// Hent nettverk fra miljøvariabel (eller bruk 'devnet' som standard)
const network = process.env.CLUSTER || 'devnet';

// Erstatt dette med din eksporterte secret key fra Phantom
// NB!! Pass på at du aldri committer eller pusher denne nøkkelen til Git.
// Bruk miljøvariabel SOLANA_SECRET_KEY for å unngå hardkoding.
const secretKeyBase58 = process.env.SOLANA_SECRET_KEY;

if (!secretKeyBase58) {
  console.error('❌ Feil: SOLANA_SECRET_KEY er ikke satt. Angi den før du kjører skriptet.');
  process.exit(1);
}

// Definer wallet path
const walletsDir = path.resolve(process.cwd(), 'wallets');
const outputPath = path.join(walletsDir, `${network}-id.json`);

// Funksjon for å be brukeren bekrefte før overskriving
const askUserConfirmation = (message: string): Promise<boolean> => {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y');
    });
  });
};

// Hovedfunksjon for å lagre nøkkelen trygt
const saveWallet = async () => {
  if (fs.existsSync(outputPath)) {
    console.warn(`⚠️ Advarsel: Det finnes allerede en wallet-fil for ${network} på ${outputPath}`);
    const confirm = await askUserConfirmation('Er du sikker på at du vil OVERSKRIVE denne? (yes/no): ');
    if (!confirm) {
      console.log('🚫 Avbrutt. Ingen filer ble endret.');
      process.exit(0);
    }
  }

  // Dekod secret key fra Base58
  const secretKey = bs58.decode(secretKeyBase58);

  // Konverter til JSON array
  const secretKeyArray = Array.from(secretKey);

  // Lag JSON-streng
  const jsonArray = JSON.stringify(secretKeyArray);

  // Opprett wallets-mappen hvis den ikke eksisterer
  if (!fs.existsSync(walletsDir)) {
    fs.mkdirSync(walletsDir, { recursive: true });
  }

  // Skriv til fil
  fs.writeFileSync(outputPath, jsonArray);

  console.log(`✅ ${network}-id.json har blitt oppdatert med din secret key. Path: ${outputPath}`);
};

saveWallet();