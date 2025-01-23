import fs from 'fs'
import path from 'path'

// 1) Solana Web3
import {
  Connection,
  clusterApiUrl,
  PublicKey as SolanaPublicKey,
  SystemProgram,
  Cluster,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js'

// 2) UMI + Metaplex
import {
  generateSigner,
  keypairIdentity,
  publicKey, // UMI-kompatibel PublicKey
  transactionBuilder,
  createSignerFromKeypair,
  percentAmount,
  some, // Brukes til å pakke inn revisjonen
} from '@metaplex-foundation/umi'
import { createUmi as createBundleUmi } from '@metaplex-foundation/umi-bundle-defaults'

import {
  createProgrammableNft,
  fetchDigitalAsset,
  mplTokenMetadata,
  TokenStandard,
} from '@metaplex-foundation/mpl-token-metadata'

// Importer instruksjonen, PDA-hjelpefunksjonen og riktige typer fra mpl-token-auth-rules
import {
  createOrUpdateV1,
  CreateOrUpdateV1InstructionAccounts,
  CreateOrUpdateV1InstructionArgs,
  RuleSetRevisionV2,
  findRuleSetPda,
} from '@metaplex-foundation/mpl-token-auth-rules'

// 3) Hjelpefunksjoner
import {
  airdropIfRequired,
  getExplorerLink,
  getKeypairFromFile,
} from '@solana-developers/helpers'

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
} from '@solana/spl-token'

/* -----------------------------
   0) Oppsett
------------------------------ */
const CLUSTER = (process.env.CLUSTER || 'devnet') as Cluster
if (!['devnet', 'testnet', 'mainnet-beta'].includes(CLUSTER)) {
  throw new Error(
    `Invalid CLUSTER value: ${CLUSTER}. Must be 'devnet', 'testnet', or 'mainnet-beta'.  Current value: '${CLUSTER}'`
  )
}
console.log(`Using network: ${CLUSTER}`)

const connection = new Connection(clusterApiUrl(CLUSTER))
const assetsPath = process.env.ASSETS_PATH || './assets'
const keypairPath =
  process.env.KEYPAIR_PATH || '/home/chieftec/.config/solana/id.json'

/* -----------------------------
   Last inn bruker (Solana Keypair) & Airdrop
------------------------------ */
console.log('Laster inn lokal keypair fra sti:', keypairPath)
const user = await getKeypairFromFile(keypairPath)
console.log('\nLoaded user', user.publicKey.toBase58())

try {
  // Forsøk å airdroppe om nødvendig
  console.log('Sjekker saldo og airdrop om nødvendig...')
  await retryOperation(
    async () => {
      await airdropIfRequired(
        connection,
        user.publicKey,
        1 * LAMPORTS_PER_SOL,
        0.5 * LAMPORTS_PER_SOL
      )
    },
    5,
    3000
  ) // Prøv opptil 5 ganger med 3 sekunders ventetid
} catch (err) {
  console.error('Feil under lasting av keypair eller airdrop:', err.message)
  process.exit(1) // Avslutt prosessen med en feilkode
}

/**
 * Helper: Utfør en operasjon med automatisk gjentakelse ved feil.
 * @param operation - En asynkron funksjon som skal utføres.
 * @param retries - Maksimalt antall forsøk.
 * @param delayMs - Ventetid mellom forsøk (i millisekunder).
 */
async function retryOperation(
  operation: () => Promise<void>,
  retries: number,
  delayMs: number
) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await operation()
      return // Avslutt hvis operasjonen lykkes
    } catch (err) {
      if (attempt < retries) {
        console.log(
          `Feil i forsøk ${attempt}. Prøver igjen om ${
            delayMs / 1000
          } sekunder...`
        )
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      } else {
        console.error('Alle forsøk mislyktes:', err.message)
        throw err // Kast feilen etter siste forsøk
      }
    }
  }
}

/* -----------------------------
   2) UMI-instans + plugin
------------------------------ */
const umi = createBundleUmi(connection.rpcEndpoint)
umi.use(mplTokenMetadata())

// Lag en UMI-signer fra Solana Keypair
const umiUser = umi.eddsa.createKeypairFromSecretKey(user.secretKey)
const umiUserSigner = createSignerFromKeypair(umi, umiUser)
umi.use(keypairIdentity(umiUserSigner))

console.log('Set up Umi instance for user.')

/* -----------------------------
   3) Definer Rule Set
------------------------------ */

// Vi bruker ruleSetName kun for PDA-utledning og som metadata
const ruleSetName = 'DrainTheSwampRuleSet'

// Konverter eierens publicKey til UMI-kompatibelt format
const umiOwner = publicKey(user.publicKey.toBase58())

// 3b) Bruk findRuleSetPda for å utlede PDA-en for Rule Set
const ruleSetPda = await findRuleSetPda(umi, {
  owner: umiOwner,
  name: ruleSetName,
})
console.log('RuleSet PDA:', ruleSetPda.toString())

// 3c) Lag RuleSetRevisionV2 med riktig struktur
const ruleSetRevisionV2: RuleSetRevisionV2 = {
  libVersion: 2,
  name: ruleSetName, // Påkrevd felt for RuleSetRevisionV2
  owner: umiOwner,
  operations: {
    'Transfer:WalletToWallet': { type: 'Pass' },
    'Transfer:Owner': { type: 'Pass' },
    'Transfer:MigrationDelegate': { type: 'Pass' },
    'Transfer:SaleDelegate': { type: 'Pass' },
    'Transfer:TransferDelegate': { type: 'Pass' },
    'Delegate:LockedTransfer': { type: 'Pass' },
    'Delegate:Update': { type: 'Pass' },
    'Delegate:Transfer': { type: 'Pass' },
    'Delegate:Utility': { type: 'Pass' },
    'Delegate:Staking': { type: 'Pass' },
    'Delegate:Authority': { type: 'Pass' },
    'Delegate:Collection': { type: 'Pass' },
    'Delegate:Use': { type: 'Pass' },
    'Delegate:Sale': { type: 'Pass' },
    // Eksempel: Legg til en ekstra regel for Transfer-operasjonen
    Transfer: {
      type: 'AdditionalSigner',
      publicKey: umiOwner,
    },
  },
}

// 3d) Bygg parametere for createOrUpdateV1-instruksen (ruleset-transaksjon)
const ruleSetAccounts: CreateOrUpdateV1InstructionAccounts = {
  payer: umiUserSigner,
  ruleSetPda,
  systemProgram: publicKey(SystemProgram.programId.toBase58()),
}

// Innpakking av revisjonen med some() slik at den blir sendt inn riktig
const ruleSetArgs: CreateOrUpdateV1InstructionArgs = {
  ruleSetRevision: some(ruleSetRevisionV2),
}

// Lag transaksjonsbuilder for Rule Set
const ruleSetTxBuilder = createOrUpdateV1(
  {
    payer: umiUserSigner,
    programs: umi.programs,
  },
  {
    ...ruleSetAccounts,
    ...ruleSetArgs,
  }
)

// console.log('RuleSetRevision:', JSON.stringify(ruleSetRevisionV2, null, 2));

// SEND TRANSKSJON 1: Opprett/oppdater Rule Set
console.log('\nSender transaksjon for opprettelse/oppdatering av Rule Set...')
await ruleSetTxBuilder.sendAndConfirm(umi)
console.log('Ruleset opprettet/oppdatert.')

/* -----------------------------
   4) Opprett pNFT (Collection)
------------------------------ */
console.log('\nLeser collection metadata...')
const collectionMetadataPath = path.join(assetsPath, 'metadata/collection')
const metadataFiles = fs
  .readdirSync(collectionMetadataPath)
  .filter((file) => file.endsWith('.json'))

if (metadataFiles.length === 0) {
  throw new Error(
    `No metadata files found in collection folder: ${collectionMetadataPath}. Please ensure there is at least one .json file.`
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

// Opprett ny mint via UMI
const collectionMint = generateSigner(umi)

const metadataUri = collectionMetadata.uri
if (!metadataUri.startsWith('http')) {
  throw new Error(`metadata.uri is not a valid URL: ${metadataUri}`)
}

// Bygg instruksjonen for pNFT-opprettelse
const createPnftBuilder = await createProgrammableNft(umi, {
  mint: collectionMint,
  name: collectionMetadata.name,
  symbol: collectionMetadata.symbol,
  uri: metadataUri,
  sellerFeeBasisPoints: percentAmount(10, 2),
  isCollection: true,
  isMutable: true,
  tokenStandard: TokenStandard.ProgrammableNonFungible, // Angir at NFT-en er programmabel (pNFT)
  ruleSet: ruleSetPda,
} as any) // Bruker typeomforming for å omgå TypeScript-sjekken

// Lag transaksjonsbuilder for pNFT-opprettelse
const pnftTxBuilder = transactionBuilder().add(createPnftBuilder)

// SEND TRANSKSJON 2: Opprett pNFT
console.log('\nSender transaksjon for opprettelse av pNFT (Collection)...')
await pnftTxBuilder.sendAndConfirm(umi)
console.log(
  `\n✅ Created Collection pNFT!\nAddress: ${getExplorerLink(
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

const createdPnft = await waitForMintAccount(
  publicKey(collectionMint.publicKey.toString())
)

// console.log(`Mint verified on-chain: ${createdPnft.mint.publicKey.toString()}`)

const mintPublicKey = collectionMint.publicKey
const mintPublicKeyWeb3 = new SolanaPublicKey(mintPublicKey.toString())
const userPublicKeyWeb3 = new SolanaPublicKey(user.publicKey.toBase58())

// Generer Associated Token Address (ATA) med riktige typer
const associatedTokenAddress = await getAssociatedTokenAddress(
  mintPublicKeyWeb3, // Mint Address som Solana Web3 PublicKey
  userPublicKeyWeb3, // Owner Address som Solana Web3 PublicKey
  false, // Ikke tillat ATA for token med metadata
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID
)

/* -----------------------------
   6) Lagre minted pNFT-adresse
------------------------------ */
const mintedCollectionAddress = createdPnft.mint.publicKey.toString()
const cacheFolder = path.join('./assets', 'cache')

if (!fs.existsSync(cacheFolder)) {
  fs.mkdirSync(cacheFolder)
}

// Oppsummering av adresser
console.log(`Mint Address: ${mintPublicKey.toString()}`)
console.log(`Token Address (ATA): ${associatedTokenAddress.toBase58()}`)
console.log(`Owner Address: ${user.publicKey.toBase58()}`)
console.log(`RuleSet PDA: ${ruleSetPda.toString()}`)

const collectionAddressFile = path.join(cacheFolder, 'collection-address.json')
fs.writeFileSync(
  collectionAddressFile,
  JSON.stringify({ address: mintedCollectionAddress }, null, 2),
  'utf8'
)

console.log(`\nSaved collection address to ${collectionAddressFile}`)
