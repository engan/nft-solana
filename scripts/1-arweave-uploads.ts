import { Keypair } from '@solana/web3.js';
import Arweave from 'arweave';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { volumeMapping } from './0-volume-mapping';

//////////////////////////////////////////////
//  1) Les miljøvariabler fra .env.mainnet   //
//////////////////////////////////////////////
dotenv.config({ path: '.env.mainnet' });
const ARWEAVE_WALLET_PATH = process.env.ARWEAVE_WALLET || '';
const volumeKey = process.env.VOLUME || 'vol02'; 
const volumeInfo = volumeMapping[volumeKey] || { folderName: volumeKey };
const ASSETS_PATH  = path.join('volumes', volumeInfo.folderName, 'assets');

const BASE_ARWEAVE_URL = process.env.BASE_ARWEAVE_URL || 'https://arweave.net';
const uploadSinglePair = process.env.SINGLE_NFT_PAIR || '';

// Hent Solana wallet-fil – dette er den lommeboken du ønsker å bruke som updateAuthority og til mottak av royalties
const SOLANA_WALLET_PATH = path.join(process.cwd(), process.env.SOLANA_WALLET || 'wallets/mainnet-id.json');

// Valider at Arweave-lommebokfilen finnes
if (!fs.existsSync(ARWEAVE_WALLET_PATH)) {
  throw new Error(`ARWEAVE_WALLET file not found at path: ${ARWEAVE_WALLET_PATH}`);
}

// Valider at Solana wallet-filen finnes
if (!fs.existsSync(SOLANA_WALLET_PATH)) {
  throw new Error(`SOLANA_WALLET file not found at path: ${SOLANA_WALLET_PATH}`);
}
// Les inn Solana keypair og hent publicKey (dette er adressen som skal brukes som updateAuthority og i creators-feltet)
const secretKeyString = fs.readFileSync(SOLANA_WALLET_PATH, 'utf8');
const secretKeyArray = JSON.parse(secretKeyString);
const secretKey = Uint8Array.from(secretKeyArray);
const solanaWallet = Keypair.fromSecretKey(secretKey);
const solanaWalletAddress = solanaWallet.publicKey.toBase58();
console.log(`Solana Wallet Address (updateAuthority & royalty mottaker): ${solanaWalletAddress}`);

//////////////////////////////////////////////
//  2) Initialiser Arweave-klient          //
//////////////////////////////////////////////
const arweave = Arweave.init({
  host: 'arweave.net',
  port: 443,
  protocol: 'https',
});

// Funksjon for å hente filtype (png, jpg eller json)
const getFileExtension = (fileName: string): 'png' | 'jpg' | 'json' | null => {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.png') return 'png';
  if (ext === '.jpg' || ext === '.jpeg') return 'jpg';
  if (ext === '.json') return 'json';
  return null;
};

//////////////////////////////////////////////
//  3) Funksjoner for å laste opp filer    //
//////////////////////////////////////////////

/**
 * Oppdater metadatafil med bildeinfo.
 * – Setter 'image' feltet til BASE_ARWEAVE_URL/bildeTxId.
 * – Oppretter/oppdaterer properties.files med URI, MIME-type og beskrivelse ("Arweave image file").
 * – Setter properties.category til 'image' og fjerner evt. eksisterende properties.creators.
 * – Legger til et toppnivå "creators" felt med wallet-adressen (dette skal være den samme som updateAuthority ved minting).
 * – Oppdaterer uploadInfo.imageUpload med bildeopplastningsdetaljer.
 * – Fjerner evt. toppnivå 'uri' før metadataen patch'es.
 *
 * @param metadataFile – Stien til metadatafilen.
 * @param imageTxId – Transaksjons-IDen for opplastet bilde.
 * @param walletAddress – Den Solana-adressen som skal settes som creator (og senere updateAuthority).
 */
const updateMetadataFileImage = (metadataFile: string, imageFile: string, imageTxId: string, walletAddress: string) => {
  const fileExtension = getFileExtension(imageFile);
  // Bestem MIME-type basert på filendelse (her forutsatt jpg og png)
  const mimeType = fileExtension === 'jpg' ? 'image/jpeg' : 'image/png';
  const metadataContent = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));

  // Sett 'image'-feltet til den fullstendige URL-en for bildet
  metadataContent.image = `${BASE_ARWEAVE_URL}/${imageTxId}`;

  // Oppdater properties.files med bildeinformasjon
  metadataContent.properties = metadataContent.properties || {};
  metadataContent.properties.files = [
    {
      uri: `${BASE_ARWEAVE_URL}/${imageTxId}`,
      type: mimeType,
      description: "Arweave image file"
    }
  ];
  metadataContent.properties.category = 'image';
  // Fjern evt. tidligere definert creators i properties
  if (metadataContent.properties.creators) {
    delete metadataContent.properties.creators;
  }

  // Sett creators på toppnivå – denne adressen (walletAddress) vil motta royalties og er den samme som updateAuthority ved minting
  metadataContent.creators = [
    {
      address: walletAddress,
      verified: true,
      share: 100
    }
  ];

  // Oppdater uploadInfo.imageUpload med detaljene om bildeopplastningen
  metadataContent.uploadInfo = metadataContent.uploadInfo || {};
  metadataContent.uploadInfo.imageUpload = {
    transactionId: imageTxId,
    file: {
      uri: `${BASE_ARWEAVE_URL}/${imageTxId}`,
      type: mimeType,
      description: "Arweave image file"
    }
  };

  // Fjern evt. tidligere toppnivå 'uri'-felt for å unngå forvirring
  if (metadataContent.uri) {
    delete metadataContent.uri;
  }

  fs.writeFileSync(metadataFile, JSON.stringify(metadataContent, null, 2));
  console.log(`Updated metadata file: ${metadataFile} with image ID: ${imageTxId}, MIME type: ${mimeType}, and creators: ${walletAddress}`);
};

/**
 * retryUpload: Laster opp fil til Arweave med valgfri tags og retry-mekanisme.
 * Returnerer transaksjonens ID (TxID) ved suksess.
 */
const retryUpload = async (
  filePath: string,
  arweave: Arweave,
  jwk: any,
  tags: { name: string; value: string }[] = [],
  maxRetries = 10,
  delay = 5000
): Promise<string> => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Attempt ${attempt}/${maxRetries}: Uploading file: ${filePath}`);
      const data = fs.readFileSync(filePath);

      // Opprett Arweave-transaksjon med filinnhold
      const transaction = await arweave.createTransaction({ data }, jwk);

      // Legg til eventuelle tags, for eksempel Content-Type
      for (const tag of tags) {
        transaction.addTag(tag.name, tag.value);
      }
      // Signer transaksjonen med Arweave-nøkkelen
      await arweave.transactions.sign(transaction, jwk);
      // Send transaksjonen
      const response = await arweave.transactions.post(transaction);

      if (response.status === 200) {
        console.log(`File uploaded successfully on attempt ${attempt}. TxID: ${transaction.id}`);
        return transaction.id;
      } else {
        console.error(`Arweave upload failed. Status: ${response.status}, Data: ${response.data}`);
      }
    } catch (error: any) {
      console.error(`Upload attempt ${attempt} for ${filePath} failed:`, error);
      if (attempt === maxRetries) {
        throw new Error(`All ${maxRetries} attempts failed for file: ${filePath}. Last error: ${error.message}`);
      }
    }
    console.log(`Retrying upload after ${delay}ms...`);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error('Should never reach here if throw is used above.');
};

/**
 * uploadCollectionInTwoSteps:
 * 1) Laster opp collection-bildet og oppdaterer lokal metadata med bildeinfo.
 * 2) Laster opp metadatafilen, og patch'er den med både .uri og uploadInfo.metadataUpload.
 *
 * @param walletAddress – Solana-adressen som brukes i "creators" feltet (samme som updateAuthority ved minting).
 */
async function uploadCollectionInTwoSteps(
  arweave: Arweave,
  jwk: any,
  collectionImageFile: string,
  metadataFilePath: string,
  walletAddress: string
): Promise<{ imageTxId: string; metadataTxId: string }> {
  console.log('\n=== Uploading collection image (two-step) ===');

  // 1) Last opp collection-bildet
  const fileExtension = getFileExtension(collectionImageFile);
  const contentType =
    fileExtension === 'png'
      ? 'image/png'
      : fileExtension === 'jpg'
      ? 'image/jpeg'
      : 'application/octet-stream';

  const imageTxId = await retryUpload(collectionImageFile, arweave, jwk, [
    { name: 'Content-Type', value: contentType },
  ]);
  console.log('Collection image TxID:', imageTxId);

  // 2) Oppdater lokal metadatafil med bildeinfo (bruker Solana wallet-adressen)
  updateMetadataFileImage(metadataFilePath, collectionImageFile, imageTxId, walletAddress);

  // 3) Last opp metadatafilen til Arweave
  console.log('\nUploading collection metadata...');
  const metadataTxId = await retryUpload(metadataFilePath, arweave, jwk, [
    { name: 'Content-Type', value: 'application/json' },
  ]);
  console.log('Collection metadata TxID:', metadataTxId);

  // 4) Oppdater metadatafilen med metadataUpload-informasjon slik at både bilde og metadata kan hentes via BASE_ARWEAVE_URL
  const metadataContent = JSON.parse(fs.readFileSync(metadataFilePath, 'utf8'));
  metadataContent.uploadInfo = metadataContent.uploadInfo || {};
  metadataContent.uploadInfo.metadataUpload = {
    transactionId: metadataTxId,
    file: {
      uri:  `${BASE_ARWEAVE_URL}/${metadataTxId}`,
      type: 'application/json',
      description: 'Arweave metadata file'
    }
  };
  // Patch .uri for enkel referanse
  metadataContent.uri = `${BASE_ARWEAVE_URL}/${metadataTxId}`;
  fs.writeFileSync(metadataFilePath, JSON.stringify(metadataContent, null, 2));
  console.log(`Patched metadata file with metadataUpload: ${BASE_ARWEAVE_URL}/${metadataTxId}`);

  return { imageTxId, metadataTxId };
}

/**
 * uploadNftInTwoSteps:
 * 1) Laster opp NFT-bildet og oppdaterer lokal metadata med bildeinfo.
 * 2) Laster opp NFT-metadatafilen, og patch'er den med både .uri og uploadInfo.metadataUpload.
 *
 * @param walletAddress – Solana-adressen som skal brukes i "creators" feltet (samme som updateAuthority ved minting).
 */
async function uploadNftInTwoSteps(
  arweave: Arweave,
  jwk: any,
  nftImageFile: string,
  nftMetadataFile: string,
  walletAddress: string
): Promise<{ imageTxId: string; metadataTxId: string }> {
  console.log(`\n--- Uploading NFT image: ${nftImageFile} ---`);

  // 1) Last opp NFT-bildet
  const fileExtension = getFileExtension(nftImageFile);
  const contentType =
    fileExtension === 'png'
      ? 'image/png'
      : fileExtension === 'jpg'
      ? 'image/jpeg'
      : 'application/octet-stream';

  const imageTxId = await retryUpload(nftImageFile, arweave, jwk, [
    { name: 'Content-Type', value: contentType },
  ]);
  console.log('NFT image TxID:', imageTxId);

  // 2) Oppdater NFT-metadatafilen med bildeinfo (bruker Solana wallet-adressen)
  updateMetadataFileImage(nftMetadataFile, nftImageFile, imageTxId, walletAddress);

  // 3) Last opp NFT-metadata til Arweave
  console.log('Uploading NFT metadata...');
  const metadataTxId = await retryUpload(nftMetadataFile, arweave, jwk, [
    { name: 'Content-Type', value: 'application/json' },
  ]);
  console.log('NFT metadata TxID:', metadataTxId);

  // 4) Oppdater metadatafilen med metadataUpload-informasjon slik at NFT-metadataen hentes korrekt
  const metadataContent = JSON.parse(fs.readFileSync(nftMetadataFile, 'utf8'));
  metadataContent.uploadInfo = metadataContent.uploadInfo || {};
  metadataContent.uploadInfo.metadataUpload = {
    transactionId: metadataTxId,
    file: {
      uri: `${BASE_ARWEAVE_URL}/${metadataTxId}`,
      type: 'application/json',
      description: 'Arweave metadata file'
    }
  };
  metadataContent.uri = `${BASE_ARWEAVE_URL}/${metadataTxId}`;
  fs.writeFileSync(nftMetadataFile, JSON.stringify(metadataContent, null, 2));
  console.log(`Patched NFT metadata file with metadataUpload: ${BASE_ARWEAVE_URL}/${metadataTxId}`);

  return { imageTxId, metadataTxId };
};

////////////////////////////////////////
//  4) Main upload prosess            //
////////////////////////////////////////
const uploadAssets = async (): Promise<void> => {
  // Les Arweave-nøkkelen
  const jwkPath = path.join(process.cwd(), ARWEAVE_WALLET_PATH);
  if (!fs.existsSync(jwkPath)) {
    throw new Error(`Arweave wallet file not found at path: ${jwkPath}`);
  }
  const jwk = JSON.parse(fs.readFileSync(jwkPath, 'utf8'));

  // Hent Arweave wallet-adressen og sjekk saldo
  const walletAddress = await arweave.wallets.jwkToAddress(jwk);
  let winstonBalance = await arweave.wallets.getBalance(walletAddress);
  const initialBalanceAR = parseFloat(arweave.ar.winstonToAr(winstonBalance));
  console.log(`\nArweave wallet address: ${walletAddress}`);
  console.log(`Initial Arweave balance: ${initialBalanceAR} AR`);

  // Definer filstier for collection og NFT-er
  const paths = {
    collectionImages: path.join(ASSETS_PATH, 'images/collection'),
    collectionMetadata: path.join(ASSETS_PATH, 'metadata/collection'),
    nftImages: path.join(ASSETS_PATH, 'images/nfts'),
    nftMetadata: path.join(ASSETS_PATH, 'metadata/nfts'),
  };

  // Les filer fra de definerte mappene
  const files = {
    collectionImages: fs
      .readdirSync(paths.collectionImages)
      .filter((file) => getFileExtension(file) !== null)
      .map((file) => path.join(paths.collectionImages, file)),
    collectionMetadata: fs
      .readdirSync(paths.collectionMetadata)
      .filter((file) => /\.json$/i.test(file))
      .map((file) => path.join(paths.collectionMetadata, file)),
    nftImages: fs
      .readdirSync(paths.nftImages)
      .filter((file) => getFileExtension(file) !== null)
      .map((file) => path.join(paths.nftImages, file)),
    nftMetadata: fs
      .readdirSync(paths.nftMetadata)
      .filter((file) => /\.json$/i.test(file))
      .map((file) => path.join(paths.nftMetadata, file)),
  };

  // Valider at antall NFT-bilder og metadatafiler matcher
  if (files.nftImages.length !== files.nftMetadata.length) {
    const missingFiles =
      files.nftImages.length > files.nftMetadata.length
        ? 'Metadata missing for some images.'
        : 'Images missing for some metadata files.';
    throw new Error(`Mismatched NFT images and metadata. ${missingFiles}`);
  }

  // Håndter selektiv opplasting for collection-filer
  let collectionImageFile: string | undefined;
  let collectionMetadataFile: string | undefined;
  if (uploadSinglePair) {
    const filteredImages = files.collectionImages.filter(file => file.includes(uploadSinglePair));
    const filteredMetadata = files.collectionMetadata.filter(file => file.includes(uploadSinglePair));
    if (filteredImages.length === 0 || filteredMetadata.length === 0) {
      console.log(`Ingen collection-filer funnet med identifikatoren "${uploadSinglePair}". Collection opplasting hoppes over.`);
    } else {
      collectionImageFile = filteredImages[0];
      collectionMetadataFile = filteredMetadata[0];
    }
  } else {
    // Standard: ta den første filen
    collectionImageFile = files.collectionImages[0];
    collectionMetadataFile = files.collectionMetadata[0];
  }

  if (collectionImageFile && collectionMetadataFile) {
    console.log('\n=== Uploading Collection to Arweave ===');
    // Bruk SOLANA_WALLET_ADDRESS (den nye adressen) som creators for både collection og NFT-er
    const { imageTxId: collImgTxId, metadataTxId: collMetaTxId } =
      await uploadCollectionInTwoSteps(arweave, jwk, collectionImageFile, collectionMetadataFile, solanaWalletAddress);
    console.log(`\nCollection uploaded. 
     Metadata: ${BASE_ARWEAVE_URL}/${collMetaTxId}
     Image:    ${BASE_ARWEAVE_URL}/${collImgTxId}`);
  } else {
    console.log('Collection-filer ble ikke valgt for opplasting.');
  }

  // NFT Batch Upload
  for (let i = 0; i < files.nftImages.length; i++) {
    const nftImageFile = files.nftImages[i];
    const nftMetadataFile = files.nftMetadata[i];

    // Hvis en spesifikk NFT skal gjenopplastes, hopp over par som ikke matcher identifikatoren
    if (
      uploadSinglePair &&
      !nftImageFile.includes(uploadSinglePair) &&
      !nftMetadataFile.includes(uploadSinglePair)
    ) {
      console.log(`Skipping NFT pair: ${nftImageFile} and ${nftMetadataFile}`);
      continue;
    }

    console.log(`\n=== Uploading NFT #${i + 1} of ${files.nftImages.length} ===`);
    const { imageTxId, metadataTxId } = await uploadNftInTwoSteps(arweave, jwk, nftImageFile, nftMetadataFile, solanaWalletAddress);
    console.log(`✅ NFT #${i + 1} uploaded. 
       Metadata: ${BASE_ARWEAVE_URL}/${metadataTxId}
       Image:    ${BASE_ARWEAVE_URL}/${imageTxId}`);
  }

  // Vis slutt-saldo for Arweave
  winstonBalance = await arweave.wallets.getBalance(walletAddress);
  const finalBalanceAR = parseFloat(arweave.ar.winstonToAr(winstonBalance));
  const totalCost = initialBalanceAR - finalBalanceAR;
  console.log(`\nAll assets uploaded successfully!`);
  console.log(`Final Arweave balance: ${finalBalanceAR.toFixed(6)} AR`);
  console.log(`Total spent: ${totalCost.toFixed(6)} AR`);
};

uploadAssets().catch((err) => {
  console.error('Error:', err);
});
