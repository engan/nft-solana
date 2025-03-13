import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'
import { volumeMapping } from './0-volume-mapping';

// 1) Solana Web3
import {
  Connection,
  clusterApiUrl,
  PublicKey as SolanaPublicKey,
  SystemProgram,
  Cluster,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
  Keypair as SolanaKeypair,
} from '@solana/web3.js'

// 2) UMI + Metaplex
import { createUmi as createBundleUmi } from '@metaplex-foundation/umi-bundle-defaults'
import {
  keypairIdentity,
  publicKey, // UMI-kompatibel PublicKey
  transactionBuilder,
  percentAmount,
  generateSigner,
  createSignerFromKeypair, // Gir en UMI-kompatibel Signer
  some, // For Option<T>
} from '@metaplex-foundation/umi'
import {
  // Fjernet: createProgrammableNft,  // Bruker nå createNft for vanlige NFT-er
  createNft, // NY: Opprett standard NFT
  fetchDigitalAsset,
  mplTokenMetadata,
} from '@metaplex-foundation/mpl-token-metadata'

// 3) Token Auth Rules (for enforceable royalties)
// Fjernet: import { findRuleSetPda } from '@metaplex-foundation/mpl-token-auth-rules'

// 4) Hjelpefunksjoner
import { airdropIfRequired, getExplorerLink } from '@solana-developers/helpers'

import { fromWeb3JsInstruction } from '@metaplex-foundation/umi-web3js-adapters'

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
} from '@solana/spl-token'

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
   Last inn bruker (Solana Keypair) & Airdrop
------------------------------ */
const userSecretArray = JSON.parse(fs.readFileSync(keypairPath, 'utf8'))
const userKeypair = SolanaKeypair.fromSecretKey(new Uint8Array(userSecretArray))
console.log('\nLoaded user', userKeypair.publicKey.toBase58())

try {
  if (CLUSTER === 'devnet') {
    await retryOperation(
      async () => {
        await airdropIfRequired(
          connection,
          userKeypair.publicKey,
          1 * LAMPORTS_PER_SOL,
          0.5 * LAMPORTS_PER_SOL
        )
      },
      5,
      3000
    )
  } else {
    console.log('Airdrop is only enabled for devnet.')
  }
} catch (err: any) {
  console.error('Feil under lasting av keypair eller airdrop:', err.message)
  process.exit(1)
}

/**
 * Helper: Utfør en operasjon med automatisk gjentakelse ved feil.
 */
async function retryOperation(
  operation: () => Promise<void>,
  retries: number,
  delayMs: number
) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await operation()
      return
    } catch (err: any) {
      if (attempt < retries) {
        console.log(
          `Feil i forsøk ${attempt}. Prøver igjen om ${
            delayMs / 1000
          } sekunder...`
        )
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      } else {
        console.error('Alle forsøk mislyktes:', err.message)
        throw err
      }
    }
  }
}

/* -----------------------------
   2) UMI-instans + plugin
------------------------------ */
const umi = createBundleUmi(connection.rpcEndpoint)
umi.use(mplTokenMetadata())

// Opprett UMI Keypair fra Solana Keypair
const umiUser = umi.eddsa.createKeypairFromSecretKey(userKeypair.secretKey)
// For at instruksjonene skal godta payer, lager vi en UMI-kompatibel Signer:
const umiUserSigner = createSignerFromKeypair(umi, umiUser)

umi.use(keypairIdentity(umiUserSigner))
console.log(
  'Set up Umi instance for user. Loaded user public key:',
  umiUserSigner.publicKey.toString()
)

/* -------------------------------------------------------
   3) Gjenbruk av RuleSet - gjelder pNFT (Ikke for NFT)
------------------------------------------------------- */
// Komentert ut for vanlig NFT - ruleSet brukes kun for pNFT
// const ruleSetNameGlobal = 'MyRoyaltyRuleSet';
// const umiOwner = publicKey(umiUserSigner.publicKey.toString());
// const ruleSetPda = await findRuleSetPda(umi, { owner: umiOwner, name: ruleSetNameGlobal });
// console.log('RuleSet PDA:', ruleSetPda.toString());

/* -----------------------------
   4) Opprett NFT (Collection)
------------------------------ */
console.log('\nLeser collection metadata...')
const collectionMetadataPath = path.join(assetsPath, 'metadata', 'collection')
const metadataFiles = fs
  .readdirSync(collectionMetadataPath)
  .filter((file) => file.endsWith('.json'))

if (metadataFiles.length === 0) {
  throw new Error(
    `No metadata files found in collection folder: ${collectionMetadataPath}.`
  )
} else if (metadataFiles.length > 1) {
  console.warn(
    `Warning: Multiple metadata files found in collection folder: ${collectionMetadataPath}. Using the first one: ${metadataFiles[0]}`
  )
}

const collectionMetadataFile = path.join(
  collectionMetadataPath,
  metadataFiles[0]
)
const collectionMetadata = JSON.parse(
  fs.readFileSync(collectionMetadataFile, 'utf8')
)
console.log('Collection JSON read from disk:', collectionMetadataFile)

// Opprett ny mint for NFT-samling (vanlig NFT)
// Endret: Bruker createNft istedenfor createProgrammableNft, og fjerner ruleSet-parameteren
const collectionMint = generateSigner(umi)

const metadataUri = collectionMetadata.uri
if (!metadataUri.startsWith('http')) {
  throw new Error(`metadata.uri is not a valid URL: ${metadataUri}`)
}

// Les inn verdier fra .env med standardverdier dersom de ikke er satt
const microLamports = Math.max(
  parseInt(process.env.COMPUTE_MICROLAMPORTS || '2000', 10),
  1 // Sørger for at microLamports ikke er mindre enn 1
)
const unitLimit = parseInt(process.env.COMPUTE_UNIT_LIMIT || '200000', 10)

// Bruk disse verdiene i ComputeBudgetProgram-innstillingene
const addPriorityFee = ComputeBudgetProgram.setComputeUnitPrice({
  microLamports,
})
const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({
  units: unitLimit,
})

// Konverter instruksjonene til Umi-kompatible instruksjoner
const umiModifyComputeUnits = fromWeb3JsInstruction(modifyComputeUnits)
const umiAddPriorityFee = fromWeb3JsInstruction(addPriorityFee)

// Vi definerer en factory-funksjon som bygger opp transaksjonen på nytt hver gang,
// slik at vi får en fersk blockhash for hver retry.
const txBuilderFactory = () => {
  return transactionBuilder()
    .add({
      instruction: umiModifyComputeUnits,
      signers: [],
      bytesCreatedOnChain: 0, // Dersom instruksjonen oppretter kontoer på kjeden
    })
    .add({
      instruction: umiAddPriorityFee,
      signers: [],
      bytesCreatedOnChain: 0,
    })
    .add(
      createNft(umi, {
        mint: collectionMint,
        name: collectionMetadata.name,
        symbol: collectionMetadata.symbol,
        uri: metadataUri,
        sellerFeeBasisPoints: percentAmount(10, 2), // 10% royalties
        isCollection: true,
        isMutable: false,
      })
    )
}

console.log('\nSender transaksjon for opprettelse av NFT (Collection)...')
// Bruk retryOperation slik at vi bygger en ny transaksjon for hver retry,
// og dermed henter en fersk blockhash
await retryOperation(
  async () => {
    const freshTxBuilder = txBuilderFactory()
    await freshTxBuilder.sendAndConfirm(umi)
  },
  3,
  2000
)

console.log(
  `\n✅ Created NFT Collection!\nAddress: ${getExplorerLink(
    'address',
    collectionMint.publicKey,
    CLUSTER
  )}`
)

/* -----------------------------
   5) Vent til mint-konto er synlig
------------------------------ */
async function waitForMintAccount(
  umiMintPublicKey: ReturnType<typeof publicKey>,
  maxRetries = 10,
  delayMs = 3000
) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const asset = await fetchDigitalAsset(umi, umiMintPublicKey)
      return asset
    } catch (err) {
      console.log(
        `Retry ${
          i + 1
        }/${maxRetries}: Waiting for mint account to become visible...`
      )
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
  throw new Error(
    `Mint account not found after ${maxRetries} retries. PublicKey: ${umiMintPublicKey.toString()}`
  )
}

const createdNft = await waitForMintAccount(
  publicKey(collectionMint.publicKey.toString())
)
console.log(
  `Mint verified on-chain (NFT collection): ${createdNft.mint.publicKey.toString()}`
)

const mintPublicKey = collectionMint.publicKey
const mintPublicKeyWeb3 = new SolanaPublicKey(mintPublicKey.toString())
const userPublicKeyWeb3 = new SolanaPublicKey(
  umiUserSigner.publicKey.toString()
)

// Finn ATA
const associatedTokenAddress = await getAssociatedTokenAddress(
  mintPublicKeyWeb3,
  userPublicKeyWeb3,
  false,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID
)

console.log(`\nMint Address: ${mintPublicKey.toString()}`)
console.log(`Token Address (ATA): ${associatedTokenAddress.toBase58()}`)
console.log(`Owner Address: ${umiUserSigner.publicKey.toString()}`)
// Fjernet: console.log(`RuleSet PDA: ${ruleSetPda.toString()}`)

const cacheFolder = path.join(assetsPath, 'cache'); // 🚀 Bruk riktig volum!

// Opprett cache-mappen hvis den ikke finnes
if (!fs.existsSync(cacheFolder)) {
  fs.mkdirSync(cacheFolder, { recursive: true });
}

const collectionAddressFile = path.join(cacheFolder, 'collection-address.json')
fs.writeFileSync(
  collectionAddressFile,
  JSON.stringify(
    { mintedCollectionAddress: mintPublicKey.toString() },
    null,
    2
  ),
  'utf8'
)

console.log(`\nSaved collection address to ${collectionAddressFile}`)
