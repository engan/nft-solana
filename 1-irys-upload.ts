import { Uploader } from '@irys/upload'
import { Solana } from '@irys/upload-solana'
import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'

// Leser inn miljøvariabler fra .env-filen
dotenv.config()

// Hent JSON-nøkkelen fra miljøvariabler
const jsonKey = (() => {
  try {
    return JSON.parse(process.env.PRIVATE_KEY || '[]')
  } catch (err) {
    throw new Error(
      'Failed to parse PRIVATE_KEY. Ensure it is formatted correctly in .env.'
    )
  }
})()

if (jsonKey.length !== 64) {
  throw new Error('JSON key is invalid or does not contain 64 elements.')
}

// Konverter JSON-nøkkel til Base58
const getBase58PrivateKey = () => {
  const keypair = Keypair.fromSecretKey(Uint8Array.from(jsonKey))
  return bs58.encode(keypair.secretKey) // Konverter til Base58
}

// Initialiser en Irys-instans
const getIrysUploader = async () => {
  const base58Key = getBase58PrivateKey()
  if (!base58Key) {
    throw new Error('Base58 Private Key could not be generated.')
  }

  const uploader = await Uploader(Solana)
    .withWallet(bs58.decode(base58Key))
    .withRpc('https://api.devnet.solana.com')
    .devnet()

  return uploader
}

// Fund en node på Irys devnet
const fundNode = async (uploader: any, retries = 3) => {
  // Vi prøver inntil 'retries' ganger
  for (let i = 0; i < retries; i++) {
    try {
      const fundTx = await uploader.fund(uploader.utils.toAtomic(0.05)) // Fund med 0.05 SOL
      console.log(
        `Successfully funded: ${uploader.utils.fromAtomic(fundTx.quantity)} ${
          uploader.token
        }`
      )
      return
    } catch (e) {
      if (i === retries - 1) {
        console.error('Error funding node:', e)
        throw e
      }
      console.log(
        `Fund attempt ${i + 1}/${retries} failed. Retrying in ${
          5 * (i + 1)
        }s...`
      )
      // Gi serveren litt ro mellom forsøk
      await new Promise((resolve) => setTimeout(resolve, 5000 * (i + 1)))
    }
  }
}

// Hjelpefunksjon: hent balanse
const getNodeBalance = async (uploader: any): Promise<number> => {
  const atomicBalance = await uploader.getBalance()
  return parseFloat(uploader.utils.fromAtomic(atomicBalance))
}

// Forsikre oss om at noden har nok funds
const ensureFunded = async (
  uploader: any,
  minBalance = 0.05, // Redusert fra 0.1
  fundAmount = 0.05
) => {
  const currentBalance = await getNodeBalance(uploader)
  console.log(`\nNode balance is: ${currentBalance.toFixed(4)} ${uploader.token}`)

  if (currentBalance < minBalance) {
    console.log(
      `Balance under ${minBalance} SOL. Attempting to fund ${fundAmount} SOL...`
    )
    await fundNode(uploader)
    const newBalance = await getNodeBalance(uploader)
    console.log(`New node balance: ${newBalance.toFixed(4)} ${uploader.token}`)

    if (newBalance < 0.01) {
      // Redusert sjekk
      throw new Error(
        'Insufficient balance after attempting to fund. Aborting.'
      )
    }
  } else {
    console.log(`Node already has >= ${minBalance} SOL. No need to fund.`)
  }
}

/**
 * Oppdater metadata (lokalt) sin .image = <imageId>.
 * Vi setter IKKE .uri her for *neste* steg, fordi
 * i to-trinns-prosess patcher vi .uri med metadataId.
 */
const updateMetadataFileImage = (
  metadataFile: string,
  imageId: string,
  fileExtension: 'png' | 'jpg'
) => {
  const metadataContent = JSON.parse(fs.readFileSync(metadataFile, 'utf8'))
  const mimeType = fileExtension === 'jpg' ? 'image/jpeg' : 'image/png'

  // Sett bare .image = bildefilen
  metadataContent.image = `https://devnet.irys.xyz/${imageId}`

  // Evt. bare sett en midlertidig .uri = bildet (til vi patcher i neste steg)
  // (Du kan utelate dette helt hvis du vil.)
  metadataContent.uri = `https://devnet.irys.xyz/${imageId}`

  metadataContent.properties = {
    files: [
      {
        uri: `https://devnet.irys.xyz/${imageId}`,
        type: mimeType,
      },
    ],
    category: 'image',
  }

  fs.writeFileSync(metadataFile, JSON.stringify(metadataContent, null, 2))
  console.log(
    `Updated metadata file: ${metadataFile} with image ID: ${imageId} and MIME type: ${mimeType}`
  )
}

// Upload-funksjoner
const retryUpload = async (file: string, uploader: any, retries = 3) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await uploader.uploadFile(file)
      return result
    } catch (error) {
      console.error(`Upload attempt ${attempt}/${retries} failed. Retrying...`)
      if (attempt === retries) {
        throw error // Kaster feilen hvis alle forsøk mislykkes
      }
      await new Promise((resolve) => setTimeout(resolve, 5000)) // Vent 5 sekunder før ny opplasting
      console.error('Error during upload:', error.config)
      console.error('Request data:', error.request)
      console.error('Response data:', error.response?.data)
    }
  }
}

/**
 * Laster opp BILDE -> patcher local metadata (.image),
 * laster opp METADATA -> får metadataId,
 * patcher local metadata (.uri = metadataId).
 *
 * NB: Samme logikk som for Collection, men her er det “per NFT”.
 */
async function uploadNftInTwoSteps(
  uploader: any,
  nftImageFile: string,
  nftMetadataFile: string,
  fileExtension: 'png' | 'jpg'
): Promise<string> {
  // 1) Last opp bilde
  console.log(`\n--- Uploading NFT image: ${nftImageFile} ---`)
  const imageResult = await retryUpload(nftImageFile, uploader)
  const imageId = imageResult.id
  console.log('NFT image ID:', imageId)

  // 2) Oppdater .image i local JSON
  console.log('Updating local NFT metadata with .image')
  updateMetadataFileImage(nftMetadataFile, imageId, fileExtension)

  // 3) Last opp METADATA -> “metadataId”
  console.log('Uploading NFT metadata...')
  const metaResult = await retryUpload(nftMetadataFile, uploader)
  const metadataId = metaResult.id
  console.log('NFT metadata ID:', metadataId)

  // 4) Patch local metadata -> .uri = metadataId
  const metadataContent = JSON.parse(fs.readFileSync(nftMetadataFile, 'utf8'))
  metadataContent.uri = `https://devnet.irys.xyz/${metadataId}`
  fs.writeFileSync(nftMetadataFile, JSON.stringify(metadataContent, null, 2))
  console.log(
    `Patched .uri in ${nftMetadataFile} to "https://devnet.irys.xyz/${metadataId}"`
  )

  // 5) (Valgfritt) Re-laste opp metadata for full “self-referential” fil hos Irys
  // console.log('Re-uploading patched NFT metadata...');
  // const secondMetaResult = await retryUpload(nftMetadataFile, uploader);
  // console.log('Final NFT metadata ID:', secondMetaResult.id);
  // return secondMetaResult.id;

  // Uten re-opplasting er .uri i den lokale fila riktig,
  // men fila på Irys har fremdeles .uri = bildefil. 
  // Det er OK for mange brukstilfeller.
  return metadataId
}

/**
 * Samme logikk, men for Collection:
 * - Laster opp *collection-bilde*
 * - Patcher local .image
 * - Laster opp *collection-metadata*
 * - Patcher local .uri = metadataId
 */
async function uploadCollectionInTwoSteps(
  uploader: any,
  collectionImageFile: string,
  metadataFilePath: string,
  fileExtension: 'png' | 'jpg'
): Promise<string> {
  // 1) Last opp collection-bilde
  console.log('\n=== Uploading collection image (two-step) ===')
  const imageResult = await retryUpload(collectionImageFile, uploader)
  const imageId = imageResult.id
  console.log('Collection image ID:', imageId)

  // 2) Oppdater metadata med .image
  updateMetadataFileImage(metadataFilePath, imageId, fileExtension)

  // 3) Last opp collection-metadata
  console.log('\nUploading collection metadata...')
  const metaResult = await retryUpload(metadataFilePath, uploader)
  const metadataId = metaResult.id
  console.log('Collection metadata ID:', metadataId)

  // 4) Patch .uri i local fil
  const metadataContent = JSON.parse(fs.readFileSync(metadataFilePath, 'utf8'))
  metadataContent.uri = `https://devnet.irys.xyz/${metadataId}`
  fs.writeFileSync(metadataFilePath, JSON.stringify(metadataContent, null, 2))
  console.log(
    `Patched .uri in ${metadataFilePath} to https://devnet.irys.xyz/${metadataId}`
  )

  // 5) (Valgfritt) Re-laste opp patched fil til Irys
  // ...
  return metadataId
}

// Hovedfunksjon for opplasting
const uploadAssets = async (): Promise<void> => {
  const uploader = await getIrysUploader()
  await ensureFunded(uploader)

  // Stier til asset-foldere
  const paths = {
    collectionImages: './assets/images/collection',
    collectionMetadata: './assets/metadata/collection',
    nftImages: './assets/images/nfts',
    nftMetadata: './assets/metadata/nfts',
  }

  // Hent alle filer
  const files = {
    collectionImages: fs
      .readdirSync(paths.collectionImages)
      .map((file) => path.join(paths.collectionImages, file)),
    collectionMetadata: fs
      .readdirSync(paths.collectionMetadata)
      .map((file) => path.join(paths.collectionMetadata, file)),
    nftImages: fs
      .readdirSync(paths.nftImages)
      .map((file) => path.join(paths.nftImages, file)),
    nftMetadata: fs
      .readdirSync(paths.nftMetadata)
      .map((file) => path.join(paths.nftMetadata, file)),
  }

  //
  // ================ COLLECTION ================
  //
  if (
    files.collectionImages.length === 0 ||
    files.collectionMetadata.length === 0
  ) {
    throw new Error(
      'No collection image or metadata found. Please place them in the correct folders.'
    )
  }

  const collectionImageFile = files.collectionImages[0] // Tar første fil
  const collectionMetadataFile = files.collectionMetadata[0]

  // Filtype "png" hvis du vet det er PNG
  const finalCollectionMetadataId = await uploadCollectionInTwoSteps(
    uploader,
    collectionImageFile,
    collectionMetadataFile,
    'png'
  )

  console.log(
    `\nDone uploading collection. Final metadata ID is: ${finalCollectionMetadataId}`
  )
  console.log(
    `Collection JSON now has .uri = "https://devnet.irys.xyz/${finalCollectionMetadataId}"`
  )

  //
  // ================ NFT-ER ================
  //
  if (files.nftImages.length !== files.nftMetadata.length) {
    throw new Error(
      `Mismatched NFT images (${files.nftImages.length}) vs metadata (${files.nftMetadata.length})`
    )
  }

  for (let i = 0; i < files.nftImages.length; i++) {
    console.log(`\n=== Uploading NFT #${i + 1} of ${files.nftImages.length} ===`)
    const nftImageFile = files.nftImages[i]
    const nftMetadataFile = files.nftMetadata[i]
    const finalNftMetadataId = await uploadNftInTwoSteps(
      uploader,
      nftImageFile,
      nftMetadataFile,
      'png'
    )
    console.log(
      `✅ NFT #${i + 1} local JSON now has .uri = https://devnet.irys.xyz/${finalNftMetadataId}`
    )
  }

  console.log('\nAll assets uploaded successfully!')
}

// Kjør prosessen
uploadAssets().catch((err) => console.error('Error:', err))
