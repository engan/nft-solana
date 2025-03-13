import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { volumeMapping } from './0-volume-mapping';
import {
  findMetadataPda,
  fetchDigitalAsset,
  verifyCollection,
  findMasterEditionPda,
} from '@metaplex-foundation/mpl-token-metadata';
import {
  airdropIfRequired,
  getExplorerLink,
} from '@solana-developers/helpers';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import {
  Cluster,
  Connection,
  LAMPORTS_PER_SOL,
  clusterApiUrl,
  Keypair as SolanaKeypair,
} from '@solana/web3.js';
import { keypairIdentity, publicKey } from '@metaplex-foundation/umi';
import {
  TokenStandard,
  mplTokenMetadata,
} from '@metaplex-foundation/mpl-token-metadata';

/* -----------------------------
   0) Oppsett
------------------------------ */
// Først last inn en standard .env (dersom den finnes)
dotenv.config();

const CLUSTER = (process.env.CLUSTER || 'devnet') as Cluster;
if (!['devnet', 'testnet', 'mainnet-beta'].includes(CLUSTER)) {
  throw new Error(
    `Invalid CLUSTER value: ${CLUSTER}. Must be 'devnet', 'testnet', or 'mainnet-beta'. Current value: '${CLUSTER}'`
  );
}
console.log(`Using network: ${CLUSTER}`);

const envFile = `.env.${CLUSTER}`;
if (!fs.existsSync(envFile)) {
  throw new Error(`Environment file ${envFile} does not exist!`);
}

// Last inn den spesifikke .env-filen
dotenv.config({ path: envFile });

const connection = new Connection(clusterApiUrl(CLUSTER));
const volumeKey = process.env.VOLUME || 'vol02';
const volumeInfo = volumeMapping[volumeKey] || { folderName: volumeKey };
const assetsPath = path.join('volumes', volumeInfo.folderName, 'assets');

console.log(`📂 Bruker volum: ${volumeKey} (${volumeInfo.folderName})`);

// Definer keypair-fil basert på CLUSTER
const keypairFilename = CLUSTER === 'devnet' ? 'devnet-id.json' : 'mainnet-id.json';
const keypairPath = path.join(process.cwd(), 'wallets', keypairFilename);

if (!fs.existsSync(keypairPath)) {
  throw new Error(`Keypair file not found at path: ${keypairPath}`);
}

/* -----------------------------
   1) Last inn Keypair & Airdrop
------------------------------ */
console.log('Laster inn lokal keypair fra sti:', keypairPath);
const userSecretArray = JSON.parse(fs.readFileSync(keypairPath, 'utf8'));
const userKeypair = SolanaKeypair.fromSecretKey(new Uint8Array(userSecretArray));
console.log('\nLoaded user', userKeypair.publicKey.toBase58());

// Airdrop (kun for devnet)
await airdropIfRequired(
  connection,
  userKeypair.publicKey,
  1 * LAMPORTS_PER_SOL,
  0.5 * LAMPORTS_PER_SOL
);
console.log('\nAirdrop sjekket (kun for devnet)');

/* -----------------------------
   2) Opprett UMI-instans
------------------------------ */
const umi = createUmi(connection.rpcEndpoint);
umi.use(mplTokenMetadata());

// Opprett UMI Keypair fra Solana Keypair
const umiUser = umi.eddsa.createKeypairFromSecretKey(userKeypair.secretKey);
// Sett identiteten med keypairIdentity
umi.use(keypairIdentity(umiUser));
console.log('Set up Umi instance for user. Loaded user public key:', umiUser.publicKey.toString());

/* -----------------------------
   3) Les inn collection-adressen
------------------------------ */
const collectionAddressFile = path.join(assetsPath, 'cache', 'collection-address.json'); // 🚀 Bruk volumets cache-mappe!

if (!fs.existsSync(collectionAddressFile)) {
  throw new Error(
    `collection-address.json not found at '${collectionAddressFile}'. 
     Kjør '3-create-collection.ts' først for å lage en NFT-samling.`
  );
}

// Les filen og hent collection-adressen
const { mintedCollectionAddress } = JSON.parse(fs.readFileSync(collectionAddressFile, 'utf8'));

// Sjekk om mintedCollectionAddress er gyldig base58
if (!isBase58(mintedCollectionAddress)) {
  console.log(`⚠️ The collection address "${mintedCollectionAddress}" is not valid base58. Probably pNFT => skipping entire verification.`);
  process.exit(0); // Avbryt hele skriptet
}

// Konverter til UMI-liknende publicKey
const collectionMintPubkey = publicKey(mintedCollectionAddress);
console.log(`\nCollection Mint Address (Base58): ${mintedCollectionAddress}\nUsing PublicKey(...) =>`, collectionMintPubkey);

/* -----------------------------
   4) Verifiser collection NFT
------------------------------ */
// Fjernet: Verifisering av selve samlings-NFT-en er ikke nødvendig.
// Du kan eventuelt logge at vi hopper over denne verifiseringen.
console.log('\nSkipping verification of the collection NFT itself (not required for a collection NFT).');

/* -----------------------------
   5) Les inn NFT-adresser
------------------------------ */
const nftAddressesFile = path.join(assetsPath, 'cache', 'nft-addresses.json'); // 🚀 Bruk volumets cache-mappe!

if (!fs.existsSync(nftAddressesFile)) {
  throw new Error(
    `nft-addresses.json not found at '${nftAddressesFile}'. 
     Kjør '4-create-pnfts.ts' først for å lage NFT-er.`
  );
}

const parsedNfts = JSON.parse(fs.readFileSync(nftAddressesFile, 'utf8'));
const nftAddresses = Array.isArray(parsedNfts)
  ? parsedNfts
  : parsedNfts.mintedNftAddresses; // Avhengig av hva du lagrer i 3-create-nfts.ts

if (!Array.isArray(nftAddresses) || nftAddresses.length === 0) {
  throw new Error('No NFT addresses found in nft-addresses.json.');
}

console.log(`\nFound ${nftAddresses.length} NFT addresses to verify.`);

/* -----------------------------
   6) Hjelpefunksjon: Er NFT allerede verifisert?
------------------------------ */
async function isNFTVerified(nftAddress: string) {
  try {
    const nftPubkey = publicKey(nftAddress);
    const nft = await fetchDigitalAsset(umi, nftPubkey);
    if (nft.metadata.collection.__option === 'None') {
      return false;
    }
    const coll = nft.metadata.collection;
    return (
      coll.__option === 'Some' &&
      coll.value.verified &&
      coll.value.key.toString() === mintedCollectionAddress
    );
  } catch (error) {
    console.error(`Error checking verification status for NFT ${nftAddress}:`, error);
    return false;
  }
}

/* -----------------------------
   7) Verifiser hver NFT (hopper over pNFT)
------------------------------ */
for (const nftAddressString of nftAddresses) {
  console.log(`\nProcessing NFT: ${nftAddressString}`);

  try {
    // 1) Er den en valid base58 streng?
    if (!isBase58(nftAddressString)) {
      console.log(`⚠️ Skipper verifisering av NFT ${nftAddressString}, da adressen ikke er base58.`);
      continue;
    }

    // 2) Hent data
    const nftPubkey = publicKey(nftAddressString);
    const nftAsset = await fetchDigitalAsset(umi, nftPubkey);
    const tokenStandardOption = nftAsset.metadata.tokenStandard;

    // 3) Hopp over pNFT
    if (
      tokenStandardOption.__option === 'Some' &&
      tokenStandardOption.value === TokenStandard.ProgrammableNonFungible
    ) {
      console.log(
        `⚠️ Skipper verifisering for pNFT ${nftAddressString}, ` +
        `fordi "verify" ikke er støttet for pNFT ennå.\n` +
        `See Explorer at ${getExplorerLink('address', nftPubkey, CLUSTER)}`
      );
      continue;
    }

    // 4) Sjekk om allerede verifisert
    const verified = await isNFTVerified(nftAddressString);
    if (verified) {
      console.log(
        `🔍 NFT ${nftAddressString} is already verified - skipping.\n` +
        `See Explorer at ${getExplorerLink('address', nftPubkey, CLUSTER)}`
      );
      continue;
    }

    console.log(`🔄 NFT ${nftAddressString} needs verification - proceeding...`);

    const nftMetadataPda = findMetadataPda(umi, { mint: nftPubkey });
    const collectionMetadataPda = findMetadataPda(umi, { mint: collectionMintPubkey });
    const collectionMasterEditionPda = findMasterEditionPda(umi, { mint: collectionMintPubkey });

    const verifyTx = await verifyCollection(umi, {
      metadata: nftMetadataPda,
      collectionMint: collectionMintPubkey,
      collectionAuthority: umi.identity,
      payer: umi.identity,
      collection: collectionMetadataPda,
      collectionMasterEditionAccount: collectionMasterEditionPda,
    });

    await verifyTx.sendAndConfirm(umi);

    console.log(
      `✅ NFT ${nftAddressString} verified as member of collection ${mintedCollectionAddress}!\n` +
      `See Explorer at ${getExplorerLink('address', nftPubkey, CLUSTER)}`
    );
  } catch (error) {
    console.error(`❌ Error processing NFT ${nftAddressString}:`, error);
  }
}

console.log('\n🎉 Processing of all NFTs completed!');

/* -----------------------------
   8) isBase58 - valgfri helper
------------------------------ */
function isBase58(str: string): boolean {
  // En enkel regex for base58: ingen 0, O, I, l + kun 1-9A-HJ-NP-Za-km-z.
  // Kan evt. mer robust validering, men dette fanger vanlige feil.
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(str);
}
