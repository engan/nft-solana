import { Uploader } from '@irys/upload'
import { Solana } from '@irys/upload-solana'
import { Cluster, Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'

// Leser inn miljøvariabler fra .env-filen
dotenv.config()

const BASE_IRYS_URL = process.env.BASE_IRYS_URL || 'https://devnet.irys.xyz'
const BASE_ARWEAVE_URL = process.env.BASE_ARWEAVE_URL || 'https://arweave.net'

const CLUSTER = (process.env.CLUSTER || 'devnet') as
  | 'devnet'
  | 'testnet'
  | 'mainnet-beta'

if (!['devnet', 'testnet', 'mainnet-beta'].includes(CLUSTER)) {
  throw new Error(
    `Invalid CLUSTER value: ${CLUSTER}. Must be 'devnet', 'testnet', or 'mainnet-beta'.`
  )
}
console.log(`Using network: ${CLUSTER}`)

// Eksempel for å bygge URL-er for sjekk
const getGatewayUrls = (transactionId: string) => {
  const irysUrl = `${BASE_IRYS_URL}/${transactionId}`
  const arweaveUrl = `${BASE_ARWEAVE_URL}/${transactionId}`
  return { irysUrl, arweaveUrl }
}

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
    .withRpc(CLUSTER)
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

// Henter filtypen basert på filnavn
const getFileExtension = (fileName: string): 'png' | 'jpg' | null => {
  const ext = path.extname(fileName).toLowerCase()
  if (ext === '.png') return 'png'
  if (ext === '.jpg' || ext === '.jpeg') return 'jpg'
  return null // Returner null for filer med ugyldig filtype
}

// Forsikre oss om at noden har nok funds
const ensureFunded = async (
  uploader: any,
  minBalance = 0.05, // Redusert fra 0.1
  fundAmount = 0.05
) => {
  const currentBalance = await getNodeBalance(uploader)
  console.log(
    `\nNode balance is: ${currentBalance.toFixed(4)} ${uploader.token}`
  )

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
const updateMetadataFileImage = (metadataFile: string, imageId: string) => {
  const fileExtension = getFileExtension(metadataFile)
  const mimeType = fileExtension === 'jpg' ? 'image/jpeg' : 'image/png'

  const metadataContent = JSON.parse(fs.readFileSync(metadataFile, 'utf8'))

  // Sett bare .image = bildefilen
  metadataContent.image = `${BASE_IRYS_URL}/${imageId}`

  // Evt. bare sett en midlertidig .uri = bildet (til vi patcher i neste steg)
  // (Du kan utelate dette helt hvis du vil.)
  metadataContent.uri = `${BASE_IRYS_URL}/${imageId}`

  metadataContent.properties = {
    files: [
      {
        uri: `${BASE_IRYS_URL}/${imageId}`,
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
const retryUpload = async (
  file: string,
  uploader: any,
  maxRetries = 5,
  delay = 3000 // Standard ventetid på 2 sekunder.
  // Kan overskrives slik: await retryUpload(nftImageFile, uploader, 7, 5000)
) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Attempt ${attempt}/${maxRetries}: Uploading file: ${file}`)
      const result = await uploader.uploadFile(file)
      console.log(`File uploaded successfully on attempt ${attempt}.`)
      return result
    } catch (error) {
      console.error(
        `Upload attempt ${attempt} failed: ${error.message || 'Unknown error'}`
      )

      if (attempt === maxRetries) {
        console.error(
          `All ${maxRetries} attempts to upload file failed. File: ${file}`
        )
        throw error // Kaster feilen hvis alle forsøk mislykkes
      }

      console.log(
        `Retrying upload after ${delay}ms... (${attempt + 1}/${maxRetries})`
      )
      await new Promise((resolve) => setTimeout(resolve, delay)) // Vent før neste forsøk
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
  reuploadMetadata = false
): Promise<string> {
  // 1) Last opp bilde
  console.log(`\n--- Uploading NFT image: ${nftImageFile} ---`)
  const imageResult = await retryUpload(nftImageFile, uploader)
  const imageId = imageResult.id
  console.log('NFT image ID:', imageId)

  // 2) Oppdater .image i local JSON
  console.log('Updating local NFT metadata with .image')
  updateMetadataFileImage(nftMetadataFile, imageId)

  // 3) Last opp METADATA -> “metadataId”
  console.log('Uploading NFT metadata...')
  const metaResult = await retryUpload(nftMetadataFile, uploader)
  const metadataId = metaResult.id
  console.log('NFT metadata ID:', metadataId)

  // 4) Patch local metadata -> .uri = metadataId
  const metadataContent = JSON.parse(fs.readFileSync(nftMetadataFile, 'utf8'))
  metadataContent.uri = `${BASE_IRYS_URL}/${metadataId}`
  fs.writeFileSync(nftMetadataFile, JSON.stringify(metadataContent, null, 2))
  console.log(
    `Patched .uri in ${nftMetadataFile} to "${BASE_IRYS_URL}/${metadataId}"`
  )

  // 5) Optional Re-laste opp metadata for full “self-referential”
  // fil hos Irys when reuploadMetadata = true
  if (reuploadMetadata) {
    console.log('Re-uploading patched NFT metadata...')
    const secondMetaResult = await retryUpload(nftMetadataFile, uploader)
    console.log('Final NFT metadata ID after re-upload:', secondMetaResult.id)
    return secondMetaResult.id
  }
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
  metadataFilePath: string
): Promise<string> {
  // 1) Last opp collection-bilde
  console.log('\n=== Uploading collection image (two-step) ===')
  const imageResult = await retryUpload(collectionImageFile, uploader)
  const imageId = imageResult.id
  console.log('Collection image ID:', imageId)

  // 2) Oppdater metadata med .image
  updateMetadataFileImage(metadataFilePath, imageId)

  // 3) Last opp collection-metadata
  console.log('\nUploading collection metadata...')
  const metaResult = await retryUpload(metadataFilePath, uploader)
  const metadataId = metaResult.id
  console.log('Collection metadata ID:', metadataId)

  // 4) Patch .uri i local fil
  const metadataContent = JSON.parse(fs.readFileSync(metadataFilePath, 'utf8'))
  metadataContent.uri = `${BASE_IRYS_URL}/${metadataId}`
  fs.writeFileSync(metadataFilePath, JSON.stringify(metadataContent, null, 2))
  console.log(
    `Patched .uri in ${metadataFilePath} to ${BASE_IRYS_URL}/${metadataId}`
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
      .filter((file) => getFileExtension(file) !== null) // Filtrer basert på gyldige filtyper
      .map((file) => path.join(paths.collectionImages, file)),
    collectionMetadata: fs
      .readdirSync(paths.collectionMetadata)
      .filter((file) => /\.json$/.test(file.toLowerCase())) // Filtrer kun JSON-filer
      .map((file) => path.join(paths.collectionMetadata, file)),
    nftImages: fs
      .readdirSync(paths.nftImages)
      .filter((file) => getFileExtension(file) !== null) // Filtrer basert på gyldige filtyper
      .map((file) => path.join(paths.nftImages, file)),
    nftMetadata: fs
      .readdirSync(paths.nftMetadata)
      .filter((file) => /\.json$/.test(file.toLowerCase())) // Filtrer kun JSON-filer
      .map((file) => path.join(paths.nftMetadata, file)),
  }
  if (files.nftImages.length !== files.nftMetadata.length) {
    const missingFiles =
      files.nftImages.length > files.nftMetadata.length
        ? 'Metadata missing for some images.'
        : 'Images missing for some metadata files.'
    throw new Error(`Mismatched NFT images and metadata. ${missingFiles}`)
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
    collectionMetadataFile
  )
  const collectionUrls = getGatewayUrls(finalCollectionMetadataId)
  console.log(
    `\nCollection uploaded. View on gateways: \nIrys: ${collectionUrls.irysUrl}\nArweave: ${collectionUrls.arweaveUrl}`
  )
  console.log(
    `Collection JSON now has .uri = "${BASE_IRYS_URL}/${finalCollectionMetadataId}" for network ${CLUSTER}`
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
    console.log(
      `\n=== Uploading NFT #${i + 1} of ${files.nftImages.length} ===`
    )
    const nftImageFile = files.nftImages[i]
    const nftMetadataFile = files.nftMetadata[i]
    const finalNftMetadataId = await uploadNftInTwoSteps(
      uploader,
      nftImageFile,
      nftMetadataFile
    )
    const urls = getGatewayUrls(finalNftMetadataId)
    console.log(
      `✅ NFT #${i + 1} uploaded. View on gateways: \nIrys: ${
        urls.irysUrl
      }\nArweave: ${urls.arweaveUrl}`
    )
  }

  console.log('\nAll assets uploaded successfully!')
}

// Kjør prosessen
uploadAssets().catch((err) => console.error('Error:', err))
