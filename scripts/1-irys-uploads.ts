import { Uploader } from '@irys/upload';
import { Solana } from '@irys/upload-solana';
import { Keypair, Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { volumeMapping } from './0-volume-mapping';

// --- Load Environment Variables ---
dotenv.config();
const CLUSTER = (process.env.CLUSTER || 'devnet') as 'devnet' | 'testnet' | 'mainnet';
const envFile = `.env.${CLUSTER}`;
if (!fs.existsSync(envFile)) {
  throw new Error(`Environment file ${envFile} does not exist!`);
}
dotenv.config({ path: envFile });
console.log(`Loaded environment file: ${envFile}`);

const BASE_IRYS_URL = process.env.BASE_IRYS_URL || ''; // Eksempel: "https://irys.example.com"
const volumeKey = process.env.VOLUME || 'vol02'; 
const volumeInfo = volumeMapping[volumeKey] || { folderName: volumeKey };
const ASSETS_PATH  = path.join('volumes', volumeInfo.folderName, 'assets');
// const ASSETS_PATH = process.env.ASSETS_PATH || '';

// --- Define Wallet Paths ---
const SOLANA_WALLET_PATH = path.join(process.cwd(), process.env.SOLANA_WALLET || 'wallets/devnet-id.json');
if (!fs.existsSync(SOLANA_WALLET_PATH)) {
  throw new Error('SOLANA_WALLET environment var missing / file not found.');
}
const solanaWallet = JSON.parse(fs.readFileSync(SOLANA_WALLET_PATH, 'utf8'));

// --- Load Mainnet Wallet for creators ---
const mainnetWalletPath = path.join(process.cwd(), 'wallets', 'mainnet-id.json');
if (!fs.existsSync(mainnetWalletPath)) {
  throw new Error(`Mainnet wallet file not found at path: ${mainnetWalletPath}`);
}
const mainnetWallet = JSON.parse(fs.readFileSync(mainnetWalletPath, 'utf8'));
const mainnetKeypair = Keypair.fromSecretKey(new Uint8Array(mainnetWallet));
const mainnetWalletPublicKey = mainnetKeypair.publicKey.toBase58();
console.log(`Using mainnet wallet address for metadata creators: ${mainnetWalletPublicKey}`);

// --- Logging and balance ---
console.log(`CLUSTER: ${CLUSTER}`);
console.log(`BASE_IRYS_URL: ${BASE_IRYS_URL}`);
console.log(`SOLANA_WALLET_PATH: ${SOLANA_WALLET_PATH}`);

const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
const pubKey = new PublicKey(mainnetWalletPublicKey);
const balance = await connection.getBalance(pubKey);
const sol = balance / 1000000000;
console.log(`Solana wallet balance: ${sol} SOL`);

// --- Helper: Build Gateway URL (kun Irys) ---
const getGatewayUrls = (transactionId: string) => {
  const irysUrl = `${BASE_IRYS_URL}/${transactionId}`;
  return { irysUrl };
};

// --- Generate Solana Keypair for Uploader ---
const jsonKey = JSON.parse(fs.readFileSync(SOLANA_WALLET_PATH, 'utf8'));
if (jsonKey.length !== 64) {
  throw new Error('PRIVATE_KEY is invalid or does not contain 64 elements.');
}
const keypair = Keypair.fromSecretKey(Uint8Array.from(jsonKey));
const walletPublicKey = keypair.publicKey.toBase58();
// const getBase58PrivateKey = () => bs58.encode(keypair.secretKey);

// --- Initialize the Irys Uploader ---
const getIrysUploader = async () => {
  let builder;
  if (CLUSTER === 'devnet') {
    const keypairFromWallet = Keypair.fromSecretKey(Uint8Array.from(solanaWallet));
    const base58Key = bs58.encode(keypairFromWallet.secretKey);
    if (!base58Key) throw new Error('Base58 Private Key could not be generated.');
    builder = Uploader(Solana)
      .withWallet(bs58.decode(base58Key))
      .withRpc('devnet')
      .devnet();
  } else if (CLUSTER === 'mainnet') {
    const base58Key = bs58.encode(mainnetKeypair.secretKey);
    if (!base58Key) throw new Error('Base58 Private Key could not be generated for mainnet wallet.');
    builder = Uploader(Solana)
      .withWallet(bs58.decode(base58Key))
      .withRpc("https://api.mainnet-beta.solana.com")
      .mainnet();
  }
  return await builder;
};

// --- Funding Logic ---
const fundNode = async (uploader: any, retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      const fundTx = await uploader.fund(uploader.utils.toAtomic(0.002)); // 0.001 SOL
      console.log(`Successfully funded: ${uploader.utils.fromAtomic(fundTx.quantity)} ${uploader.token}`);
      return;
    } catch (e) {
      if (i === retries - 1) {
        console.error('Error funding node:', e);
        throw e;
      }
      console.log(`Fund attempt ${i + 1}/${retries} failed. Retrying in ${5 * (i + 1)}s...`);
      await new Promise((resolve) => setTimeout(resolve, 5000 * (i + 1)));
    }
  }
};

const getNodeBalance = async (uploader: any): Promise<number> => {
  const atomicBalance = await uploader.getBalance();
  return parseFloat(uploader.utils.fromAtomic(atomicBalance));
};

const ensureFunded = async (uploader: any, minBalance = 0.0001, fundAmount = 0.0001) => {
  const currentBalance = await getNodeBalance(uploader);
  console.log(`\nNode balance is: ${currentBalance.toFixed(4)} ${uploader.token}`);
  if (currentBalance < minBalance) {
    console.log(`Balance under ${minBalance} SOL. Attempting to fund ${fundAmount} SOL...`);
    await fundNode(uploader);
    const newBalance = await getNodeBalance(uploader);
    console.log(`New node balance: ${newBalance.toFixed(4)} ${uploader.token}`);
    if (newBalance < 0.01) throw new Error('Insufficient balance after funding. Aborting.');
  } else {
    console.log(`Node already has >= ${minBalance} SOL. No need to fund.`);
  }
};

const getFileExtension = (fileName: string): 'png' | 'jpg' | null => {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.png') return 'png';
  if (ext === '.jpg' || ext === '.jpeg') return 'jpg';
  return null;
};

/**
 * updateMetadataFileImage:
 * - Setter toppnivå 'image' og properties.files basert på opplastet bilde-ID.
 * - Setter fast toppnivå 'creators'.
 * - Oppretter/oppdaterer uploadInfo.imageUpload med bildeopplastningsdetaljer.
 * - Fjerner eventuelle dupliserte toppnivåfelt (som 'uri').
 */
const updateMetadataFileImage = (metadataFile: string, imageFile: string, imageId: string) => {
  const fileExtension = getFileExtension(imageFile); // Bruker imageFile i stedet for metadataFile
  const mimeType = fileExtension === 'jpg' ? 'image/jpeg' : 'image/png';

  const metadataContent = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));

  // Oppdater 'image'
  metadataContent.image = `${BASE_IRYS_URL}/${imageId}`;

  // Oppdater properties.files
  metadataContent.properties = metadataContent.properties || {};
  metadataContent.properties.files = [
    {
      uri: `${BASE_IRYS_URL}/${imageId}`,
      type: mimeType,
      description: "Irys image file"
    }
  ];
  metadataContent.properties.category = 'image';

  if (metadataContent.properties.creators) {
    delete metadataContent.properties.creators;
  }

  // Sett creators på toppnivå (fast)
  metadataContent.creators = [
    {
      address: mainnetWalletPublicKey,
      verified: true,
      share: 100
    }
  ];

  // Oppdater uploadInfo.imageUpload
  metadataContent.uploadInfo = metadataContent.uploadInfo || {};
  metadataContent.uploadInfo.imageUpload = {
    transactionId: imageId,
    file: {
      uri: `${BASE_IRYS_URL}/${imageId}`,
      type: mimeType,
      description: "Irys image file"
    }
  };

  // Fjern et evt. toppnivå 'uri' før metadataopplastning patch'es
  if (metadataContent.uri) {
    delete metadataContent.uri;
  }

  fs.writeFileSync(metadataFile, JSON.stringify(metadataContent, null, 2));
  console.log(`Updated metadata file: ${metadataFile} with\nimage ID: ${imageId}, MIME type: ${mimeType}, and\ncreators: ${mainnetWalletPublicKey}`);
};

/**
 * retryUpload: Laster opp en fil med gitte forsøk og delay.
 */
const retryUpload = async (file: string, uploader: any, maxRetries = 10, delay = 2000) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Attempt ${attempt}/${maxRetries}: Uploading file: ${file}`);
      const result = await uploader.uploadFile(file);
      console.log(`File uploaded successfully on attempt ${attempt}.`);
      return result;
    } catch (error: any) {
      console.error(`Upload attempt ${attempt} failed: ${error.message || 'Unknown error'}`);
      if (attempt === maxRetries) {
        console.error(`All ${maxRetries} attempts failed. File: ${file}`);
        throw error;
      }
      console.log(`Retrying upload after ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
};

/**
 * uploadCollectionInTwoSteps:
 * 1. Last opp collection-bildet, oppdater metadatafil med bildeopplastningsinfo.
 * 2. Last opp collection-metadata.
 * Etter metadataopplastning patch'es filen med uploadInfo.metadataUpload og toppnivå 'uri'.
 */
async function uploadCollectionInTwoSteps(uploader: any, collectionImageFile: string, metadataFilePath: string): Promise<string> {
  console.log('\n=== Uploading collection image (two-step) ===');
  const fileSizeInBytes = fs.statSync(collectionImageFile).size;
  const cost = await uploader.getPrice(fileSizeInBytes);
  console.log(`Estimated cost for upload: ${uploader.utils.fromAtomic(cost)} SOL`);

  const imageResult = await retryUpload(collectionImageFile, uploader);
  const imageId = imageResult.id;
  console.log('Collection image ID:', imageId);

  updateMetadataFileImage(metadataFilePath, collectionImageFile,imageId);

  console.log('\nUploading collection metadata...');
  const metaResult = await retryUpload(metadataFilePath, uploader);
  const metadataId = metaResult.id;
  console.log('Collection metadata ID:', metadataId);

  const metadataContent = JSON.parse(fs.readFileSync(metadataFilePath, 'utf8'));
  metadataContent.uploadInfo = metadataContent.uploadInfo || {};
  metadataContent.uploadInfo.metadataUpload = {
    transactionId: metadataId,
    file: {
      uri: `${BASE_IRYS_URL}/${metadataId}`,
      type: "application/json",
      description: "Irys metadata file"
    }
  };
  // Sett toppnivå 'uri' (dette er det feltet markedsplasser leser)
  metadataContent.uri = `${BASE_IRYS_URL}/${metadataId}`;
  fs.writeFileSync(metadataFilePath, JSON.stringify(metadataContent, null, 2));
  console.log(`Patched collection metadata file with new uri: ${BASE_IRYS_URL}/${metadataId}`);

  return metadataId;
}

/**
 * uploadNftInTwoSteps:
 * 1. Last opp NFT-bildet, oppdater metadatafil med bildeopplastningsinfo.
 * 2. Last opp NFT-metadata.
 * Etter metadataopplastning patch'es filen med uploadInfo.metadataUpload og toppnivå 'uri'.
 */
async function uploadNftInTwoSteps(uploader: any, nftImageFile: string, nftMetadataFile: string, reuploadMetadata = false): Promise<string> {
  console.log(`\n--- Uploading NFT image: ${nftImageFile} ---`);
  const imageResult = await retryUpload(nftImageFile, uploader);
  const imageId = imageResult.id;
  console.log('NFT image ID:', imageId);

  console.log('Updating NFT metadata with image info...');
  updateMetadataFileImage(nftMetadataFile, nftImageFile, imageId);

  console.log('Uploading NFT metadata...');
  const metaResult = await retryUpload(nftMetadataFile, uploader);
  const metadataId = metaResult.id;
  console.log('NFT metadata ID:', metadataId);

  const metadataContent = JSON.parse(fs.readFileSync(nftMetadataFile, 'utf8'));
  metadataContent.uploadInfo = metadataContent.uploadInfo || {};
  metadataContent.uploadInfo.metadataUpload = {
    transactionId: metadataId,
    file: {
      uri: `${BASE_IRYS_URL}/${metadataId}`,
      type: "application/json",
      description: "Irys metadata file"
    }
  };
  metadataContent.uri = `${BASE_IRYS_URL}/${metadataId}`;
  fs.writeFileSync(nftMetadataFile, JSON.stringify(metadataContent, null, 2));
  console.log(`Patched NFT metadata file with new uri: ${BASE_IRYS_URL}/${metadataId}`);

  if (reuploadMetadata) {
    console.log('Re-uploading patched NFT metadata...');
    const secondMetaResult = await retryUpload(nftMetadataFile, uploader);
    console.log('Final NFT metadata ID after re-upload:', secondMetaResult.id);
    return secondMetaResult.id;
  }
  return metadataId;
}

// --- Main Upload Process ---
const uploadAssets = async (): Promise<void> => {
  const uploader = await getIrysUploader();

  if (CLUSTER === 'devnet' || CLUSTER === 'mainnet') {
    await ensureFunded(uploader);
  }
  if (CLUSTER === 'mainnet') {
    const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
    const pubKeyObj = new PublicKey(walletPublicKey);
    const balanceInLamports = await connection.getBalance(pubKeyObj);
    const solanaBalance = balanceInLamports / 1_000_000_000;
    console.log(`Solana wallet balance: ${solanaBalance.toFixed(4)} SOL`);
    const cost = await uploader.getPrice(204800);
    console.log(`\nEstimated upload cost: ${uploader.utils.fromAtomic(cost)} SOL`);
    console.log(`Current Solana wallet balance: ${solanaBalance.toFixed(4)} SOL`);
    console.log(`Using wallet public key for Irys: ${walletPublicKey}`);
    console.log(`CLUSTER: ${CLUSTER}`);
    console.log(`BASE_IRYS_URL: ${BASE_IRYS_URL}`);
  }

  const paths = {
    collectionImages: ASSETS_PATH + '/images/collection',
    collectionMetadata: ASSETS_PATH + '/metadata/collection',
    nftImages: ASSETS_PATH + '/images/nfts',
    nftMetadata: ASSETS_PATH + '/metadata/nfts',
  };

  const files = {
    collectionImages: fs.readdirSync(paths.collectionImages)
      .filter((file) => getFileExtension(file) !== null)
      .map((file) => path.join(paths.collectionImages, file)),
    collectionMetadata: fs.readdirSync(paths.collectionMetadata)
      .filter((file) => /\.json$/.test(file.toLowerCase()))
      .map((file) => path.join(paths.collectionMetadata, file)),
    nftImages: fs.readdirSync(paths.nftImages)
      .filter((file) => getFileExtension(file) !== null)
      .map((file) => path.join(paths.nftImages, file)),
    nftMetadata: fs.readdirSync(paths.nftMetadata)
      .filter((file) => /\.json$/.test(file.toLowerCase()))
      .map((file) => path.join(paths.nftMetadata, file))
  };

  if (files.nftImages.length !== files.nftMetadata.length) {
    const missingFiles = files.nftImages.length > files.nftMetadata.length
      ? 'Metadata missing for some images.'
      : 'Images missing for some metadata files.';
    throw new Error(`Mismatched NFT images and metadata. ${missingFiles}`);
  }

  // --- Collection Upload ---
  if (files.collectionImages.length === 0 || files.collectionMetadata.length === 0) {
    throw new Error('No collection image or metadata found. Please place them in the correct folders.');
  }

  const collectionImageFile = files.collectionImages[0];
  const collectionMetadataFile = files.collectionMetadata[0];
  const finalCollectionMetadataId = await uploadCollectionInTwoSteps(uploader, collectionImageFile, collectionMetadataFile);
  const collectionUrls = getGatewayUrls(finalCollectionMetadataId);
  console.log(`\nCollection uploaded. View on gateway: \nIrys: ${collectionUrls.irysUrl}`);

  // --- NFT Batch Upload ---
  for (let i = 0; i < files.nftImages.length; i++) {
    console.log(`\n=== Uploading NFT #${i + 1} of ${files.nftImages.length} ===`);
    const nftImageFile = files.nftImages[i];
    const nftMetadataFile = files.nftMetadata[i];
    const finalNftMetadataId = await uploadNftInTwoSteps(uploader, nftImageFile, nftMetadataFile);
    const urls = getGatewayUrls(finalNftMetadataId);
    console.log(`✅ NFT #${i + 1} uploaded. View on gateway: \n✅ Irys: ${urls.irysUrl}`);
  }

  console.log('\nAll assets uploaded successfully!');
};

uploadAssets().catch((err) => console.error('Error:', err));
