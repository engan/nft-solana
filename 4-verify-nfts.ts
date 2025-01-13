import {
  findMetadataPda,
  mplTokenMetadata,
  verifyCollectionV1,
  fetchDigitalAsset,
} from '@metaplex-foundation/mpl-token-metadata'
import {
  airdropIfRequired,
  getExplorerLink,
  getKeypairFromFile,
} from '@solana-developers/helpers'

import { createUmi } from '@metaplex-foundation/umi-bundle-defaults'
import { Cluster, Connection, LAMPORTS_PER_SOL, clusterApiUrl } from '@solana/web3.js'
import { keypairIdentity, publicKey } from '@metaplex-foundation/umi'

import fs from 'fs'

// Les CLUSTER fra miljøvariabelen
const CLUSTER = (process.env.CLUSTER || 'devnet') as Cluster;

// Valider at CLUSTER er en gyldig verdi
if (!['devnet', 'testnet', 'mainnet-beta'].includes(CLUSTER)) {
  throw new Error(`Invalid CLUSTER value: ${CLUSTER}. Must be 'devnet', 'testnet', or 'mainnet-beta'.`);
}
console.log(`Using network: ${CLUSTER}`);

const connection = new Connection(clusterApiUrl(CLUSTER));

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

// Lese collection-adresse fra fil (nå fra ./assets/cache/)
const collectionAddressFile = './assets/cache/collection-address.json'
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

// Lese NFT-adresser fra fil
const nftAddressesFile = './assets/cache/nft-addresses.json'
if (!fs.existsSync(nftAddressesFile)) {
  throw new Error(
    'NFT addresses file not found. Please run create-nft.ts first.'
  )
}

const nftAddresses = JSON.parse(fs.readFileSync(nftAddressesFile, 'utf8'))
if (!Array.isArray(nftAddresses) || nftAddresses.length === 0) {
  throw new Error('No NFT addresses found in nft-addresses.json.')
}

console.log(`Found ${nftAddresses.length} NFT addresses to verify.`)

// Hjelpefunksjon for å sjekke om en NFT allerede er verifisert
async function isNFTVerified(nftAddress: string) {
  try {
    const nft = await fetchDigitalAsset(umi, publicKey(nftAddress))

    // Sjekk om NFTen har en collection og om den er verifisert
    if (nft.metadata.collection.__option === 'None') {
      return false
    }

    const collection = nft.metadata.collection
    return (
      collection.__option === 'Some' &&
      collection.value.verified &&
      collection.value.key.toString() === collectionAddressString
    )
  } catch (error) {
    console.error(
      `Error checking verification status for NFT ${nftAddress}:`,
      error
    )
    return false
  }
}

// Loop gjennom og verifiser hver NFT
for (const nftAddressString of nftAddresses) {
  console.log(`\nProcessing NFT: ${nftAddressString}`)

  try {
    // Sjekk først om NFTen allerede er verifisert
    const verified = await isNFTVerified(nftAddressString)

    if (verified) {
      console.log(`🔍 NFT ${nftAddressString} is already verified - skipping`)
      continue
    }

    console.log(`🔄 NFT ${nftAddressString} needs verification - proceeding...`)

    const nftAddress = publicKey(nftAddressString)
    const transaction = await verifyCollectionV1(umi, {
      metadata: findMetadataPda(umi, { mint: nftAddress }),
      collectionMint: collectionAddress,
      authority: umi.identity,
    })

    await transaction.sendAndConfirm(umi)

    console.log(
      `✅ NFT ${nftAddressString} verified as member of collection ${collectionAddressString}!\n` +
        `See Explorer at ${getExplorerLink('address', nftAddress, 'devnet')}`
    )
  } catch (error) {
    console.error(`❌ Error processing NFT ${nftAddressString}:`, error)
    // Du kan velge å enten fortsette med neste NFT eller avbryte hele prosessen her
    // For å avbryte, legg til: throw error;
  }
}

console.log('\n🎉 Processing of all NFTs completed!')
