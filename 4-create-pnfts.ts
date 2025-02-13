import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'

// 1) Solana Web3
import {
  Connection,
  clusterApiUrl,
  PublicKey as SolanaPublicKey,
  SystemProgram,
  Cluster,
  LAMPORTS_PER_SOL,
  Keypair as SolanaKeypair,
  ComputeBudgetProgram,
  Transaction,
} from '@solana/web3.js'

// 2) UMI + Metaplex
import { createUmi as createBundleUmi } from '@metaplex-foundation/umi-bundle-defaults'
import {
  generateSigner,
  keypairIdentity,
  publicKey, // UMI-kompatibel PublicKey
  transactionBuilder,
  createSignerFromKeypair,
  percentAmount,
  Umi,
  PublicKey,
  some,
} from '@metaplex-foundation/umi'
import {
  createProgrammableNft,
  fetchDigitalAsset,
  mplTokenMetadata,
} from '@metaplex-foundation/mpl-token-metadata'

// 3) Token Auth Rules
import { findRuleSetPda } from '@metaplex-foundation/mpl-token-auth-rules'

// 4) Hjelpefunksjoner
import { airdropIfRequired, getExplorerLink } from '@solana-developers/helpers'

import { fromWeb3JsInstruction } from '@metaplex-foundation/umi-web3js-adapters'

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
} from '@solana/spl-token'

//
// -----------------------------
// 0) Oppsett
// -----------------------------
// Last inn standard .env (dersom den finnes)
dotenv.config()

// Hent CLUSTER fra miljøvariabel, standard 'devnet'
const CLUSTER = (process.env.CLUSTER || 'devnet') as Cluster
if (!['devnet', 'testnet', 'mainnet-beta'].includes(CLUSTER)) {
  throw new Error(
    `Invalid CLUSTER value: ${CLUSTER}. Must be 'devnet', 'testnet', or 'mainnet-beta'. Current value: '${CLUSTER}'`
  )
}
console.log(`Using network: ${CLUSTER}`)

// Bestem miljøfil basert på CLUSTER
const envFile = `.env.${CLUSTER}`
if (!fs.existsSync(envFile)) {
  throw new Error(`Environment file ${envFile} does not exist!`)
}
// Last inn den spesifikke .env-filen
dotenv.config({ path: envFile })

const connection = new Connection(clusterApiUrl(CLUSTER))
const assetsPath = process.env.ASSETS_PATH || './assets'

// Definer keypair-fil basert på CLUSTER
const keypairFilename =
  CLUSTER === 'devnet' ? 'devnet-id.json' : 'mainnet-id.json'
const keypairPath = path.join(process.cwd(), 'wallets', keypairFilename)
if (!fs.existsSync(keypairPath)) {
  throw new Error(`Keypair file not found at path: ${keypairPath}`)
}

// Batch-størrelse (brukes for inndeling av filer) og antall parallell mintinger
const BATCH_SIZE = 1
const PARALLEL_BATCH_SIZE = parseInt(
  process.env.PARALLEL_BATCH_SIZE || '12',
  10
)

/* -----------------------------
   Last inn bruker (Solana Keypair) & Airdrop
------------------------------ */
console.log('Laster inn lokal keypair fra sti:', keypairPath)
const userSecretArray = JSON.parse(fs.readFileSync(keypairPath, 'utf8'))
const userKeypair = SolanaKeypair.fromSecretKey(new Uint8Array(userSecretArray))
console.log('\nLoaded user', userKeypair.publicKey.toBase58())

try {
  console.log('Sjekker saldo og airdrop om nødvendig...')
  await retryOperation(
    async () => {
      if (CLUSTER === 'devnet') {
        await airdropIfRequired(
          connection,
          userKeypair.publicKey,
          1 * LAMPORTS_PER_SOL,
          0.5 * LAMPORTS_PER_SOL
        )
      } else {
        console.log('Airdrop is only relevant for devnet.')
      }
    },
    5,
    3000
  )
} catch (err: any) {
  console.error('Feil under lasting av keypair eller airdrop:', err.message)
  process.exit(1)
}

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
const umi = createBundleUmi(connection.rpcEndpoint).use(mplTokenMetadata())
const umiUser = umi.eddsa.createKeypairFromSecretKey(userKeypair.secretKey)
const umiUserSigner = createSignerFromKeypair(umi, umiUser)
umi.use(keypairIdentity(umiUserSigner))
console.log('Set up Umi instance for user:', umiUserSigner.publicKey.toString())

/* -------------------------------------------------------
   3) Gjenbruk av RuleSet
------------------------------------------------------- */
const ruleSetNameGlobal = 'MyRoyaltyRuleSet'
const umiOwner = publicKey(umiUserSigner.publicKey.toString())
const ruleSetPda = await findRuleSetPda(umi, {
  owner: umiOwner,
  name: ruleSetNameGlobal,
})
console.log('RuleSet PDA:', ruleSetPda.toString())

// -----------------------------
// 4) Les collection-adressen
// -----------------------------
const collectionPath = path.join('./assets/cache', 'collection-address.json')
if (!fs.existsSync(collectionPath)) {
  throw new Error(
    `collection-address.json not found at '${collectionPath}'. Kjør '2-create-collection.ts' først for å lage en NFT-samling.`
  )
}
const { mintedCollectionAddress } = JSON.parse(
  fs.readFileSync(collectionPath, 'utf8')
)
console.log('Using mintedCollectionAddress from file:', mintedCollectionAddress)

//
// -----------------------------
// 5) Hjelpefunksjon: Vent på at pNFT-konto er synlig
// -----------------------------
async function waitForMintAccount(
  umi: Umi,
  umiMintPublicKey: PublicKey,
  maxRetries = 6,
  delayMs = 5000
): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await fetchDigitalAsset(umi, umiMintPublicKey)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
  throw new Error(`Mint account not found after ${maxRetries} retries`)
}

//
// -----------------------------
// 6) Kjør batch-minte pNFT med konsis logging
// -----------------------------
// Hent alle NFT-metadatafilene fra mappen
const nftDir = path.join(assetsPath, 'metadata', 'nfts')
const allNftFiles = fs
  .readdirSync(nftDir)
  .filter((file) => file.endsWith('.json'))
console.log(`Total NFT-metadatafiler funnet: ${allNftFiles.length}`)

// Les miljøvariabler for maks antall og startindeks (0-basert)
// MAX_TO_MINT = 0 betyr "ingen grense" (mint alt fra START_INDEX til slutten)
const MAX_TO_MINT = parseInt(process.env.MAX_TO_MINT || '0', 10)
const START_INDEX = parseInt(process.env.START_INDEX || '0', 10)
console.log(`Minting starting from index: ${START_INDEX}`)
if (MAX_TO_MINT > 0) {
  console.log(`Minting will stop after ${MAX_TO_MINT} NFT(s) are minted.`)
}
const nftFilesToProcess =
  MAX_TO_MINT > 0
    ? allNftFiles.slice(START_INDEX, START_INDEX + MAX_TO_MINT)
    : allNftFiles.slice(START_INDEX)
console.log(
  `Antall filer som skal behandles (fra indeks ${START_INDEX}): ${nftFilesToProcess.length}`
)

// Del de utvalgte filene inn i batcher med størrelse BATCH_SIZE
const batches: string[][] = []
for (let i = 0; i < nftFilesToProcess.length; i += BATCH_SIZE) {
  batches.push(nftFilesToProcess.slice(i, i + BATCH_SIZE))
}

let mintedCount = 0
const mintedAddresses: string[] = []

// Les inn verdier fra .env med standardverdier dersom de ikke er satt
const microLamports = Math.max(
  parseInt(process.env.COMPUTE_MICROLAMPORTS || '500', 10),
  1 // Sørger for at microLamports ikke er mindre enn 1
);
const unitLimit = parseInt(process.env.COMPUTE_UNIT_LIMIT || '250000', 10);

// Bruk disse verdiene i ComputeBudgetProgram-innstillingene
const addPriorityFee = ComputeBudgetProgram.setComputeUnitPrice({
  microLamports,
});
const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({
  units: unitLimit,
});

// Konverter instruksjonene til Umi-kompatible instruksjoner
const umiModifyComputeUnits = fromWeb3JsInstruction(modifyComputeUnits)
const umiAddPriorityFee = fromWeb3JsInstruction(addPriorityFee)

// Hjelpefunksjon for minting av én NFT
async function mintSingleNFT(nftFile: string): Promise<string> {
  try {
    const metadata = JSON.parse(
      fs.readFileSync(path.join(nftDir, nftFile), 'utf8')
    )
    const nftMint = generateSigner(umi)

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
          createProgrammableNft(umi, {
            mint: nftMint,
            name: metadata.name,
            symbol: metadata.symbol || '',
            uri: metadata.uri,
            sellerFeeBasisPoints: percentAmount(10, 2),
            isCollection: false,
            isMutable: false,
            ruleSet: some(publicKey(ruleSetPda)),
            collection: {
              verified: false,
              key: publicKey(mintedCollectionAddress),
            },
          })
        )
    }

    await retryOperation(
      async () => {
        // Bygg en fersk transaksjon med ny blockhash for hver retry
        const freshTxBuilder = txBuilderFactory()
        await freshTxBuilder.sendAndConfirm(umi)
      },
      3,
      2000
    )

    await waitForMintAccount(umi, nftMint.publicKey)
    const mintedAsset = await fetchDigitalAsset(umi, nftMint.publicKey)
    if (!mintedAsset || !mintedAsset.mint) {
      throw new Error('Minted asset does not contain a valid mint address.')
    }
    return mintedAsset.mint.publicKey.toString()
  } catch (error) {
    console.error(`Feil under minting av ${nftFile}:`, error)
    throw error
  }
}

// -----------------------------
// 7) Parallell batch-prosessering
// -----------------------------
// Prosesser batcher parallelt med PARALLEL_BATCH_SIZE
for (let i = 0; i < nftFilesToProcess.length; i += PARALLEL_BATCH_SIZE) {
  if (MAX_TO_MINT > 0 && mintedCount >= MAX_TO_MINT) {
    console.log(`\nMaks antall (${MAX_TO_MINT}) er nådd. Stopper minting.`)
    break
  }
  const batchNumber = Math.floor(i / PARALLEL_BATCH_SIZE) + 1
  const balanceBefore = await getBalance(umi)
  console.log(
    `\nBatch ${batchNumber} starter med SOL-saldo: ${balanceBefore.toFixed(
      5
    )} SOL`
  )

  const currentBatch = nftFilesToProcess.slice(i, i + PARALLEL_BATCH_SIZE)
  console.log(`=== Behandler batch ${batchNumber} ===`)
  const results = await Promise.allSettled(currentBatch.map(mintSingleNFT))
  const balanceAfter = await getBalance(umi)
  const solUsed = balanceBefore - balanceAfter
  console.log(`Batch ${batchNumber} ferdig:`)
  console.log(`- Start saldo: ${balanceBefore.toFixed(5)} SOL`)
  console.log(`- Sluttsaldo: ${balanceAfter.toFixed(5)} SOL`)
  console.log(`- Totalt brukt i batch: ${solUsed.toFixed(5)} SOL`)

  const successes = results.filter(
    (r) => r.status === 'fulfilled'
  ) as PromiseFulfilledResult<string>[]
  const failures = results.filter((r) => r.status === 'rejected')
  for (const result of successes) {
    mintedAddresses.push(result.value)
    mintedCount++
    console.log(
      `✅ pNFT minted => ${getExplorerLink('address', result.value, CLUSTER)}`
    )
  }
  for (const result of failures) {
    console.error(
      `❌ Feil under minting:`,
      (result as PromiseRejectedResult).reason
    )
  }
  console.log(
    `Batch ${batchNumber} status: Suksess: ${successes.length}, Feil: ${failures.length}`
  )
}

// -----------------------------
// 8) Lagre resultater
// -----------------------------
const cacheDir = path.join('./assets', 'cache')
if (!fs.existsSync(cacheDir)) {
  fs.mkdirSync(cacheDir)
}
const nftAddressesFile = path.join(cacheDir, 'nft-addresses.json')
fs.writeFileSync(
  nftAddressesFile,
  JSON.stringify({ mintedNftAddresses: mintedAddresses }, null, 2)
)
console.log(
  `\n✅ Ferdig! Alle batcher kjørt. Lagret minted addresses i '${nftAddressesFile}'.`
)

// -----------------------------
// 9) Funksjon for å hente saldo med riktig konvertering
// -----------------------------
async function getBalance(umi: Umi): Promise<number> {
  try {
    console.log(
      'Henter saldo fra:',
      `${CLUSTER}, ${umiUserSigner.publicKey.toString()}`
    )
    const balanceObj: any = await umi.rpc.getBalance(umiUserSigner.publicKey)
    let bp: bigint
    if (typeof balanceObj.basisPoints === 'bigint') {
      bp = balanceObj.basisPoints
    } else if (typeof balanceObj.basisPoints === 'string') {
      bp = BigInt(balanceObj.basisPoints)
    } else {
      throw new Error('Ugyldig type for basisPoints')
    }
    const decimals = Number(balanceObj.decimals)
    return Number(bp) / Math.pow(10, decimals)
  } catch (error: any) {
    console.error('Feil under henting av saldo:', error.message)
    return NaN
  }
}
