import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { mplTokenMetadata, burnV1, TokenStandard, findTokenRecordPda, fetchDigitalAssetWithAssociatedToken } from '@metaplex-foundation/mpl-token-metadata';
import { keypairIdentity, publicKey } from '@metaplex-foundation/umi';
import { fromWeb3JsKeypair } from '@metaplex-foundation/umi-web3js-adapters';
import { Keypair, clusterApiUrl, Cluster } from '@solana/web3.js';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// Last inn miljøvariabler
dotenv.config();

const CLUSTER: Cluster = (process.env.CLUSTER as Cluster) || 'devnet';
const assetsPath = process.env.ASSETS_PATH || './assets';

// Definer keypair-fil basert på CLUSTER
const keypairFilename = CLUSTER === 'devnet' ? 'devnet-id.json' : 'mainnet-id.json';
const keypairPath = path.join(process.cwd(), 'wallets', keypairFilename);

if (!fs.existsSync(keypairPath)) {
  throw new Error(`Keypair-fil ikke funnet på stien: ${keypairPath}`);
}

console.log('Laster inn lokal keypair fra sti:', keypairPath);
const userSecretArray = JSON.parse(fs.readFileSync(keypairPath, 'utf8'));
const userKeypair = Keypair.fromSecretKey(new Uint8Array(userSecretArray));
const umiKeypair = fromWeb3JsKeypair(userKeypair);
console.log('\nLastet inn bruker', userKeypair.publicKey.toBase58());

// Opprett Umi-instansen
const umi = createUmi(clusterApiUrl(CLUSTER)).use(mplTokenMetadata());

// Bruk keypairIdentity med Umi
umi.use(keypairIdentity(umiKeypair));

// Definer NFT-mint-adressen som skal brenns 
const nftMintAddress = publicKey('7NLD2Ps6Xek4kjkM1gFxFAFZqf7nJA2jjQWeq3QHvm77'); // Erstatt med mint-adressen til NFTen

// NFT mint-adressen (pNFT)
const mintId = nftMintAddress;

// Hent NFT-asset med tilknyttet tokenkonto for den gitte eieren
const assetWithToken = await fetchDigitalAssetWithAssociatedToken(
  umi,
  mintId,
  umi.identity.publicKey
);

// Finn Token Record PDA
const tokenRecord = findTokenRecordPda(umi, {
  mint: nftMintAddress,
  token: umi.identity.publicKey, // Endret fra "owner" til "token"
});

// Brenn NFTen
await burnV1(umi, {
  mint: mintId,
  // Her må du sende med den tilknyttede tokenkontoens public key
  token: assetWithToken.token.publicKey,
  // Dersom NFT-en har en token-record (som pNFT-er ofte har), så inkluder den:
  tokenRecord: assetWithToken.tokenRecord?.publicKey,
  tokenStandard: TokenStandard.ProgrammableNonFungible,
}).sendAndConfirm(umi);

console.log('NFT ble brent vellykket, solana tilbakeført (ca. halve mintekostnad)!');
