// Mest for info, JSON metadata filene inneholder de faktiske dataene

export type VolumeConfig = {
  folderName: string;
  displayName?: string;
  royaltyPercent?: number;
  maxNfts?: number;
};

export const volumeMapping: Record<string, VolumeConfig> = {
  vol01: {
    folderName: 'vol01-drain-the-swamp',
    displayName: 'Drain The Swamp',
    royaltyPercent: 10,
    maxNfts: 12
  },
  vol02: {
    folderName: 'vol02-next-project',  // Rename this to the projects folder name
    displayName: 'Trumpcession',
    royaltyPercent: 10,
    maxNfts: 20
  },
  vol03: {
    folderName: 'vol03-third-project',  // Rename this to the projects folder name
    displayName: 'Trumps Touch',
    royaltyPercent: 10,
    maxNfts: 30
  },  
};

// Skriv i teminalen slikt som dette:
// CLUSTER=devnet VOLUME=vol01 npx esrun scripts/3-create-collection.ts
// CLUSTER=mainnet-beta VOLUME=vol02 npx esrun scripts/3-create-collection.ts