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

// Les CLUSTER fra miljøvariabelen
const CLUSTER = (process.env.CLUSTER || 'devnet') as Cluster;

// Valider at CLUSTER er en gyldig verdi
if (!['devnet', 'testnet', 'mainnet-beta'].includes(CLUSTER)) {
  throw new Error(`Invalid CLUSTER value: ${CLUSTER}. Must be 'devnet', 'testnet', or 'mainnet-beta'.`);
}

console.log(`Using network: ${CLUSTER}`);

const connection = new Connection(clusterApiUrl(CLUSTER));

const assetsPath = './assets/metadata/nfts'

const user = await getKeypairFromFile()
await airdropIfRequired(
  connection,
  user.publicKey,
  1 * LAMPORTS_PER_SOL,
  0.5 * LAMPORTS_PER_SOL
)

console.log('\nLoaded user', user.publicKey.toBase58())

const umi = createUmi(connection.rpcEndpoint)
umi.use(mplTokenMetadata())

const umiUser = umi.eddsa.createKeypairFromSecretKey(user.secretKey)
umi.use(keypairIdentity(umiUser))

console.log('Set up Umi instance for user')

// Les inn collection address fra fil
const collectionAddressFile = path.join(
  './assets/cache',
  'collection-address.json'
)
if (!fs.existsSync(collectionAddressFile)) {
  throw new Error(
    'Collection address file not found. Please run create-collection first.'
  )
}

const { address: collectionAddressString } = JSON.parse(
  fs.readFileSync(collectionAddressFile, 'utf8')
)

const collectionAddress = publicKey(collectionAddressString)

console.log(`Using Collection Address: ${collectionAddressString}`)

console.log('Reading metadata files...')

// Les metadatafiler fra mappen
const metadataFiles = fs
  .readdirSync(assetsPath)
  .filter((file) => file.endsWith('.json'))

if (metadataFiles.length === 0) {
  throw new Error('Ingen metadatafiler funnet i nfts-mappen.')
}

// Opprett en liste for lagring av NFT-adresser
const nftAddresses: string[] = []

/**
 * Hjelpefunksjon: Fetche NFT med retries
 */
async function waitForNFTConfirmation(
  mintPublicKey: PublicKey,
  maxAttempts = 4,
  initialDelayMs = 5000
): Promise<any> {
  let attempts = 0
  while (attempts < maxAttempts) {
    try {
      const asset = await fetchDigitalAsset(umi, mintPublicKey)
      return asset
    } catch (error) {
      attempts++
      if (attempts === maxAttempts) {
        throw new Error(
          `Failed to confirm NFT creation after ${maxAttempts} attempts`
        )
      }
      // Eksponentiell backoff - øker ventetiden for hver retry
      const delay = initialDelayMs * Math.pow(1.5, attempts)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

// Iterer gjennom metadatafilene og mint hver NFT
for (const file of metadataFiles) {
  const filePath = path.join(assetsPath, file)
  const metadata = JSON.parse(fs.readFileSync(filePath, 'utf8'))

  console.log(`\nStarting creation of NFT: ${metadata.name}`)

  try {
    const mint = generateSigner(umi)

    // Bygg og send transaksjon
    const transaction = await createNft(umi, {
      mint,
      name: metadata.name,
      symbol: metadata.symbol,
      uri: metadata.uri,
      sellerFeeBasisPoints: percentAmount(10),
      collection: {
        key: collectionAddress,
        verified: false,
      },
    })

    // Send transaksjonen og vent på bekreftelse
    await transaction.sendAndConfirm(umi)

    console.log(
      `🔄 Transaction sent for ${metadata.name}. Verifying NFT creation...`
    )

    // Vent på at NFTen faktisk er tilgjengelig på kjeden
    const createdNft = await waitForNFTConfirmation(mint.publicKey)

    const nftAddressString = createdNft.mint.publicKey.toString()
    console.log(
      `✅ NFT creation confirmed! Address: ${getExplorerLink(
        'address',
        createdNft.mint.publicKey,
        CLUSTER
      )}`
    )

    nftAddresses.push(nftAddressString)
  } catch (error) {
    console.error(`Error creating NFT ${metadata.name}:`, error)
    // Du kan velge å enten fortsette med neste NFT eller avbryte hele prosessen her
    // For å avbryte, legg til: throw error;
  }
}

// Lagre alle NFT-adresser til fil
const nftAddressesFile = path.join('./assets/cache', 'nft-addresses.json')
fs.writeFileSync(
  nftAddressesFile,
  JSON.stringify(nftAddresses, null, 2),
  'utf8'
)

console.log(
  `\nAll NFT addresses saved to ${nftAddressesFile}. Total: ${nftAddresses.length}`
)
