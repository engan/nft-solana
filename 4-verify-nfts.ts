import fs from 'fs'
import {
  findMetadataPda,
  fetchDigitalAsset,
  verifyCollection,
  findMasterEditionPda,
} from '@metaplex-foundation/mpl-token-metadata'

import {
  airdropIfRequired,
  getExplorerLink,
  getKeypairFromFile,
} from '@solana-developers/helpers'

import { createUmi } from '@metaplex-foundation/umi-bundle-defaults'
import {
  Cluster,
  Connection,
  LAMPORTS_PER_SOL,
  clusterApiUrl,
} from '@solana/web3.js'
import { keypairIdentity, publicKey } from '@metaplex-foundation/umi'

// Viktig å importere og bruke mplTokenMetadata som plugin.
import {
  TokenStandard,
  mplTokenMetadata,
} from '@metaplex-foundation/mpl-token-metadata'

/* -----------------------------
   0) Oppsett
------------------------------ */
// Les CLUSTER fra miljøvariabelen
const CLUSTER = (process.env.CLUSTER || 'devnet') as Cluster
if (!['devnet', 'testnet', 'mainnet-beta'].includes(CLUSTER)) {
  throw new Error(
    `Invalid CLUSTER value: ${CLUSTER}. Must be 'devnet', 'testnet', or 'mainnet-beta'.`
  )
}
console.log(`Using network: ${CLUSTER}`)

const connection = new Connection(clusterApiUrl(CLUSTER))

/* -----------------------------
   1) Last inn Keypair & Airdrop
------------------------------ */
const user = await getKeypairFromFile()
await airdropIfRequired(
  connection,
  user.publicKey,
  1 * LAMPORTS_PER_SOL,
  0.5 * LAMPORTS_PER_SOL
)
console.log('\nLoaded user', user.publicKey.toBase58())

/* -----------------------------
   2) Opprett UMI-instans
------------------------------ */
const umi = createUmi(connection.rpcEndpoint)
// Viktig: bruk mplTokenMetadata-plugin
umi.use(mplTokenMetadata())

// Sett opp UMI-identity fra keypair
const umiUser = umi.eddsa.createKeypairFromSecretKey(user.secretKey)
umi.use(keypairIdentity(umiUser))

console.log('Set up Umi instance for user')

/* -----------------------------
   3) Les inn collection-adresse
------------------------------ */
const collectionAddressFile = './assets/cache/collection-address.json'
if (!fs.existsSync(collectionAddressFile)) {
  throw new Error(
    'Collection address file not found. Please run create-collection first.'
  )
}

const { address: collectionAddressString } = JSON.parse(
  fs.readFileSync(collectionAddressFile, 'utf8')
)
const collectionMintPubkey = publicKey(collectionAddressString)

console.log(`Using Collection Address: ${collectionAddressString}`)

/* -----------------------------
   4) Verifiser collection NFT
------------------------------ */
console.log('\nProcessing the collection NFT for verification...')

try {
  const collectionAsset = await fetchDigitalAsset(umi, collectionMintPubkey)
  const tokenStandardOption = collectionAsset.metadata.tokenStandard

  // Sjekk om collection NFT er en pNFT og hopp over hvis ja
  if (
    tokenStandardOption.__option === 'Some' &&
    tokenStandardOption.value === TokenStandard.ProgrammableNonFungible
  ) {
    console.log(
      `⚠️ Skipper verifisering for collection pNFT ${collectionAddressString}, ` +
        `fordi "verify" ikke er støttet for ProgrammableNonFungible.\n` +
        `See Explorer at ${getExplorerLink(
          'address',
          collectionMintPubkey,
          CLUSTER
        )}`
    )
  } else {
    const collectionMetadataPda = findMetadataPda(umi, {
      mint: collectionMintPubkey,
    })
    const collectionMasterEditionPda = findMasterEditionPda(umi, {
      mint: collectionMintPubkey,
    })

    // Sjekk om collection NFT allerede er verifisert
    const collectionVerified =
      collectionAsset.metadata.collection.__option === 'Some' &&
      collectionAsset.metadata.collection.value.verified &&
      collectionAsset.metadata.collection.value.key.toString() ===
        collectionAddressString

    if (collectionVerified) {
      console.log(
        `🔍 Collection NFT ${collectionAddressString} is already verified - skipping\n` +
          `See Explorer at ${getExplorerLink(
            'address',
            collectionMintPubkey,
            CLUSTER
          )}`
      )
    } else {
      console.log(
        `🔄 Collection NFT ${collectionAddressString} needs verification - proceeding...`
      )

      const verifyCollectionTx = await verifyCollection(umi, {
        metadata: collectionMetadataPda,
        collectionMint: collectionMintPubkey,
        collectionAuthority: umi.identity,
        payer: umi.identity,
        collection: collectionMetadataPda,
        collectionMasterEditionAccount: collectionMasterEditionPda,
      })

      // Send & confirm collection verification
      await verifyCollectionTx.sendAndConfirm(umi)

      console.log(
        `✅ Collection NFT ${collectionAddressString} verified successfully!\n` +
          `See Explorer at ${getExplorerLink(
            'address',
            collectionMintPubkey,
            CLUSTER
          )}`
      )
    }
  }
} catch (error) {
  console.error(`❌ Error verifying the collection NFT:`, error)
}

/* -----------------------------
   5) Les inn NFT-adresser
------------------------------ */
const nftAddressesFile = './assets/cache/nft-addresses.json'
if (!fs.existsSync(nftAddressesFile)) {
  throw new Error(
    'NFT addresses file not found. Please run create-nft.ts first.'
  )
}

// Forventet struktur { mintedNfts: [...] } eller bare en array
const parsedNfts = JSON.parse(fs.readFileSync(nftAddressesFile, 'utf8'))
const nftAddresses = Array.isArray(parsedNfts)
  ? parsedNfts
  : parsedNfts.mintedNfts

if (!Array.isArray(nftAddresses) || nftAddresses.length === 0) {
  throw new Error('No NFT addresses found in nft-addresses.json.')
}

console.log(`\nFound ${nftAddresses.length} NFT addresses to verify.`)

/* -----------------------------
   6) Hjelpefunksjon: Er NFT allerede verifisert?
------------------------------ */
async function isNFTVerified(nftAddress: string) {
  try {
    const nft = await fetchDigitalAsset(umi, publicKey(nftAddress))
    if (nft.metadata.collection.__option === 'None') {
      return false
    }
    const coll = nft.metadata.collection
    return (
      coll.__option === 'Some' &&
      coll.value.verified &&
      coll.value.key.toString() === collectionAddressString
    )
  } catch (error) {
    console.error(
      `Error checking verification status for NFT ${nftAddress}:`,
      error
    )
    return false
  }
}

/* -----------------------------
   7) Verifiser hver NFT (hopper over pNFT)
------------------------------ */
for (const nftAddressString of nftAddresses) {
  console.log(`\nProcessing NFT: ${nftAddressString}`)

  try {
    // 1) Hent metadata for NFT
    const nftPubkey = publicKey(nftAddressString)
    const nftAsset = await fetchDigitalAsset(umi, nftPubkey)

    // 2) Finn tokenStandard
    const tokenStandardOption = nftAsset.metadata.tokenStandard

    if (
      tokenStandardOption.__option === 'Some' &&
      tokenStandardOption.value === TokenStandard.ProgrammableNonFungible
    ) {
      console.log(
        `⚠️ Skipper verifisering for pNFT ${nftAddressString}, ` +
          `fordi "verify" ikke er støttet for ProgrammableNonFungible ennå.\n` +
          `See Explorer at ${getExplorerLink('address', nftPubkey, CLUSTER)}`
      )
      continue
    }

    // 3) Sjekk om allerede verifisert
    const verified = await isNFTVerified(nftAddressString)
    if (verified) {
      console.log(
        `🔍 NFT ${nftAddressString} is already verified - skipping\n` +
          `See Explorer at ${getExplorerLink('address', nftPubkey, CLUSTER)}`
      )
      continue
    }

    console.log(`🔄 NFT ${nftAddressString} needs verification - proceeding...`)

    // 4) Bygg verifyCollection-transaksjon for "vanlig" NFT
    const nftMetadataPda = findMetadataPda(umi, { mint: nftPubkey })
    const collectionMetadataPda = findMetadataPda(umi, {
      mint: collectionMintPubkey,
    })
    const collectionMasterEditionPda = findMasterEditionPda(umi, {
      mint: collectionMintPubkey,
    })

    const verifyTx = await verifyCollection(umi, {
      metadata: nftMetadataPda,
      collectionMint: collectionMintPubkey,
      collectionAuthority: umi.identity,
      payer: umi.identity,
      collection: collectionMetadataPda,
      collectionMasterEditionAccount: collectionMasterEditionPda,
    })

    // 5) Send & confirm
    await verifyTx.sendAndConfirm(umi)

    console.log(
      `✅ NFT ${nftAddressString} verified as member of collection ${collectionAddressString}!\n` +
        `See Explorer at ${getExplorerLink('address', nftPubkey, CLUSTER)}`
    )
  } catch (error) {
    console.error(`❌ Error processing NFT ${nftAddressString}:`, error)
    // Du kan evt. avbryte hele prosessen med: throw error
  }
}

console.log('\n🎉 Processing of all NFTs completed!')
