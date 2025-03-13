import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { volumeMapping } from './0-volume-mapping';

// 1) Solana Web3
import {
  Connection,
  clusterApiUrl,
  SystemProgram,
  Cluster,
  Keypair as SolanaKeypair,
  PublicKey as SolanaPublicKey,
} from '@solana/web3.js';

// 2) UMI + Metaplex
import {
  createUmi as createBundleUmi,
} from '@metaplex-foundation/umi-bundle-defaults';
import {
  keypairIdentity,
  publicKey,
  createSignerFromKeypair,
  some,
} from '@metaplex-foundation/umi';

// 3) Token Auth Rules (for enforceable royalties)
import {
  createOrUpdateV1,
  CreateOrUpdateV1InstructionAccounts,
  CreateOrUpdateV1InstructionArgs,
  RuleSetRevisionV2,
  findRuleSetPda,
} from '@metaplex-foundation/mpl-token-auth-rules';

/* -----------------------------
   0) Oppsett
------------------------------ */
// Først last inn en standard .env (dersom den finnes)
dotenv.config()

const CLUSTER = (process.env.CLUSTER || 'devnet') as Cluster
if (!['devnet', 'testnet', 'mainnet-beta'].includes(CLUSTER)) {
  throw new Error(
    `Invalid CLUSTER value: ${CLUSTER}. Must be 'devnet', 'testnet', or 'mainnet-beta'. Current value: '${CLUSTER}'`
  )
}
console.log(`Using network: ${CLUSTER}`)

const envFile = `.env.${CLUSTER}`
if (!fs.existsSync(envFile)) {
  throw new Error(`Environment file ${envFile} does not exist!`)
}

// Last inn den spesifikke .env-filen
dotenv.config({ path: envFile })

const connection = new Connection(clusterApiUrl(CLUSTER))
const volumeKey = process.env.VOLUME || 'vol02';
const volumeInfo = volumeMapping[volumeKey] || { folderName: volumeKey };
const assetsPath = path.join('volumes', volumeInfo.folderName, 'assets');

console.log(`📂 Bruker volum: ${volumeKey} (${volumeInfo.folderName})`);

// Definer keypair-fil basert på CLUSTER
const keypairFilename =
  CLUSTER === 'devnet' ? 'devnet-id.json' : 'mainnet-id.json'
const keypairPath = path.join(process.cwd(), 'wallets', keypairFilename)

if (!fs.existsSync(keypairPath)) {
  throw new Error(`Keypair file not found at path: ${keypairPath}`)
}

/* -----------------------------
   1) Last inn bruker + UMI-instans
------------------------------ */
const userSecretArray = JSON.parse(fs.readFileSync(keypairPath, 'utf8'));
const userKeypair = SolanaKeypair.fromSecretKey(new Uint8Array(userSecretArray));
console.log('\nLoaded user:', userKeypair.publicKey.toBase58());

const umi = createBundleUmi(connection.rpcEndpoint);
umi.use(keypairIdentity(createSignerFromKeypair(umi, umi.eddsa.createKeypairFromSecretKey(userKeypair.secretKey))));

const umiOwner = publicKey(userKeypair.publicKey.toBase58());

/* -----------------------------
   2) Sjekk om RuleSet allerede finnes
------------------------------ */
const ruleSetName = 'MyRoyaltyRuleSet';
const ruleSetPda = await findRuleSetPda(umi, {
  owner: umiOwner,
  name: ruleSetName,
});
const ruleSetPdaStr = ruleSetPda.toString().split(',')[0]; // Fjerner eventuelle kommaer
console.log('\nRuleSet PDA:', ruleSetPdaStr);

// Prøv å hente kontoinformasjon for RuleSet PDA
const accountInfo = await connection.getAccountInfo(new SolanaPublicKey(ruleSetPdaStr));

if (accountInfo !== null) {
  console.log('RuleSet eksisterer allerede. Ingen handling nødvendig.');
} else {
  console.log('RuleSet eksisterer ikke. Oppretter nytt RuleSet...');

  const ruleSetRevisionV2: RuleSetRevisionV2 = {
    libVersion: 2,
    name: ruleSetName,
    owner: umiOwner,
    operations: {
      'Transfer:WalletToWallet': { type: 'Pass' },
      'Transfer:Owner': { type: 'Pass' },
      'Transfer:SaleDelegate': { type: 'Pass' },
      'Delegate:LockedTransfer': { type: 'Pass' },
      'Delegate:Update': { type: 'Pass' },
      'Delegate:Transfer': { type: 'Pass' },
      'Delegate:Sale': { type: 'Pass' },
      'Delegate:Authority': { type: 'Pass' },
      'Delegate:Collection': { type: 'Pass' },
      'Delegate:Use': { type: 'Pass' },
      'Transfer:MigrationDelegate': { type: 'Pass' },
      'Transfer:TransferDelegate': { type: 'Pass' },
      Transfer: {
        type: 'AdditionalSigner',
        publicKey: umiOwner,
      },
    },
  };

  const ruleSetAccounts: CreateOrUpdateV1InstructionAccounts = {
    payer: umi.identity,
    ruleSetPda,
    systemProgram: publicKey(SystemProgram.programId.toBase58()),
  };

  const ruleSetArgs: CreateOrUpdateV1InstructionArgs = {
    ruleSetRevision: some(ruleSetRevisionV2),
  };

  const ruleSetTxBuilder = createOrUpdateV1(
    {
      payer: umi.identity,
      programs: umi.programs,
    },
    {
      ...ruleSetAccounts,
      ...ruleSetArgs,
    }
  );

  await ruleSetTxBuilder.sendAndConfirm(umi);
  console.log('✅ Ruleset opprettet og bekreftet!');
}

/* -----------------------------
   3) Lagre RuleSet-adresse
------------------------------ */
// Oppdater cache-mappen slik at den lagres i volumet
const cacheFolder = path.join(assetsPath, 'cache');

// 🛠️ Sjekk og opprett katalogen hvis den ikke finnes
if (!fs.existsSync(cacheFolder)) {
  fs.mkdirSync(cacheFolder, { recursive: true }); // recursive: true lager hele stistrukturen om nødvendig
}

const ruleSetAddressFile = path.join(cacheFolder, 'ruleset-address.json');

fs.writeFileSync(
  ruleSetAddressFile,
  JSON.stringify({ ruleSetAddress: ruleSetPdaStr }, null, 2),
  'utf8'
);

console.log(`\n📌 RuleSet-adressen er lagret til: ${ruleSetAddressFile}`);
console.log(`🔗 Utforsk RuleSet på Solana Explorer: https://explorer.solana.com/address/${ruleSetPdaStr}?cluster=${CLUSTER}`);
