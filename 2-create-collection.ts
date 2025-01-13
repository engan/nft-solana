import fs from 'fs'
import path from 'path'
import {
  createNft,
  fetchDigitalAsset,
  mplTokenMetadata,
} from '@metaplex-foundation/mpl-token-metadata'

import {
  airdropIfRequired,
  getExplorerLink,
  getKeypairFromFile,
} from '@solana-developers/helpers'

import { createUmi } from '@metaplex-foundation/umi-bundle-defaults'

import { Cluster, Connection, LAMPORTS_PER_SOL, clusterApiUrl } from '@solana/web3.js'
import {
  generateSigner,
  keypairIdentity,
  percentAmount,
  publicKey,
  PublicKey,
} from '@metaplex-foundation/umi'

const CLUSTER = (process.env.CLUSTER || 'devnet') as Cluster;

if (!['devnet', 'testnet', 'mainnet-beta'].includes(CLUSTER)) {
    throw new Error(`Invalid CLUSTER value: ${CLUSTER}. Must be 'devnet', 'testnet', or 'mainnet-beta'.`);
}
console.log(`Using network: ${CLUSTER}`);

const connection = new Connection(clusterApiUrl(CLUSTER));

const assetsPath = './assets'

const user = await getKeypairFromFile()
await airdropIfRequired(
  connection,
  user.publicKey,
  1 * LAMPORTS_PER_SOL,
  0.5 * LAMPORTS_PER_SOL
)

console.log('\nLoaded user', user.publicKey.toBase58())

// Lag en Umi-instans
const umi = createUmi(connection.rpcEndpoint)
umi.use(mplTokenMetadata())

const umiUser = umi.eddsa.createKeypairFromSecretKey(user.secretKey)
umi.use(keypairIdentity(umiUser))

console.log('Set up Umi instance for user')

// Hent .json-filen for Collection
const collectionMetadataPath = path.join(assetsPath, 'metadata/collection')
const metadataFiles = fs
  .readdirSync(collectionMetadataPath)
  .filter((file) => file.endsWith('.json'))

if (metadataFiles.length === 0) {
  throw new Error('Ingen metadatafiler funnet i collection-mappen.')
}

// Les metadata fra JSON-filen
const collectionMetadataFile = path.join(
  collectionMetadataPath,
  metadataFiles[0]
)
const collectionMetadata = JSON.parse(
  fs.readFileSync(collectionMetadataFile, 'utf8')
)

console.log('Collection JSON read from disk:', collectionMetadataFile)

// Opprett Collection NFT
const collectionMint = generateSigner(umi)

// Hent `uri` fra local JSON. Etter 1-irys-upload.ts skal dette peke på "https://devnet.irys.xyz/<metadataId>".
const metadataUri = collectionMetadata.uri

// (Valgfritt) Hvis man er usikker på om den er komplett URL:
if (!metadataUri.startsWith('http')) {
  throw new Error(`metadata.uri is not a valid URL: ${metadataUri}`)
}

console.log(`Creating Collection NFT: ${collectionMetadata.name}`)
const transaction = await createNft(umi, {
  mint: collectionMint,
  name: collectionMetadata.name,
  symbol: collectionMetadata.symbol,
  uri: metadataUri, // Peker til metadata JSON hos Irys
  sellerFeeBasisPoints: percentAmount(10),
  isCollection: true,
})
await transaction.sendAndConfirm(umi)

console.log(
  `✅ Created Collection 📦! Address is ${getExplorerLink(
    'address',
    collectionMint.publicKey,
    CLUSTER
  )}`
)

// Funksjon for å vente på at mint-kontoen blir synlig
const waitForMintAccount = async (
  publicKey: PublicKey,
  maxRetries = 10,
  delay = 2000
) => {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const asset = await fetchDigitalAsset(umi, publicKey)
      return asset
    } catch (err) {
      console.log(
        `Retry ${
          i + 1
        }/${maxRetries}: Waiting for mint account to become visible...`
      )
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  throw new Error(
    `Mint account not found after ${maxRetries} retries. PublicKey: ${publicKey.toString()}`
  )
}

// Vent på at kontoen blir synlig
const createdCollectionNft = await waitForMintAccount(
  publicKey(collectionMint.publicKey.toString())
)

/**
 * Her lagrer vi mint-adressen til en JSON-fil, slik at 3-create-nfts.ts
 * kan lese den og knytte nye NFT-er til denne collectionen.
 */
const mintedCollectionAddress = createdCollectionNft.mint.publicKey.toString()
const cacheFolder = path.join('./assets', 'cache')

// Opprett cache-mappen om den ikke finnes
if (!fs.existsSync(cacheFolder)) {
  fs.mkdirSync(cacheFolder)
}

const collectionAddressFile = path.join(cacheFolder, 'collection-address.json')

fs.writeFileSync(
  collectionAddressFile,
  JSON.stringify({ address: mintedCollectionAddress }, null, 2),
  'utf8'
)

console.log(`\nSaved collection address to ${collectionAddressFile}`)
