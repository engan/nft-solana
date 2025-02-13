# pNFT (programmable NFTs) project with political satire illustrations generated with artificial intelligence.

| Dependency                                      | Status    |
|-------------------------------------------------|-----------|
| `@metaplex-foundation/umi`                      | ✅ Installed |
| `@metaplex-foundation/mpl-token-metadata`       | ✅ Installed |
| `@metaplex-foundation/umi-bundle-defaults`      | ✅ Installed |
| `@metaplex-foundation/mpl-token-auth-rules`     | ✅ Installed |
| `@solana/spl-token`                             | ✅ Installed |
| `@solana-developers/helpers`                    | ✅ Installed |
| `@solana/web3.js`                               | ✅ Installed |
| `@irys/upload`                                  | ✅ Installed |
| `@irys/upload-solana`                           | ✅ Installed |
| `arweave`                                       | ✅ Installed |
| `@types/node`                                   | ✅ Installed |
| `dotenv`                                        | ✅ Installed |
| `esrun`                                         | ✅ Installed |
| `bs58`                                          | ✅ Installed |
| `ts-node` (devDependencies)                     | ✅ Installed |


**A satirical pNFT project depicting themes such as power, corruption and irony, with AI-generated art.**

## Note

Image files (PNG) are excluded from this project and are only available online as NFTs.

The blockchain is Solana, and storage for images and metadata (json files) is uploaded via Irys and stored forever with a one-time payment on Arweave. Development environment in Visual Studio Code with WSL (Linux Ubuntu).


```markdown
# Solana NFT Project - Quick Setup and Deployment Guide

This guide provides a simplified approach to setting up and deploying a Solana NFT project. It covers asset upload, NFT creation, and verification.

## Prerequisites

Ensure you have the following installed:

*   **WSL (Windows Subsystem for Linux)**
*   **VSCode**
*   **Node.js & npm**
*   **pnpm** (install globally: `npm install -g pnpm`)
*   **Solana CLI**
*   **nvm (Node Version Manager)** (optional, but recommended)

Verify versions of key tools in your terminal:

```bash
nvm --version
node --version
npm --version
pnpm --version
solana --version

You can check globally installed packages using:

```bash
pnpm list -g --depth=0
npm list -g --depth=0
```

## Setup

1.  **Project Initialization**:
    Navigate to your project directory in the WSL terminal and initialize a new project:
    ```bash
    pnpm init
    ```
    This creates a `package.json` file.

2.  **Solana CLI Configuration**:
    Configure Solana CLI to use the Devnet network and your keypair:
    ```bash
    solana config set --url https://api.devnet.solana.com --keypair ~/.config/solana/id.json
    ```
    Generate a new keypair if you don't have one: `solana-keygen new --outfile ~/.config/solana/id.json`
    You can find your public key with: `solana-keygen pubkey`
    Check your Solana configuration: `solana config get`

    To switch to Mainnet-beta, use:
    ```bash
    solana config set --url https://api.mainnet-beta.solana.com
    ```

3.  **.env File Configuration**:
    Create a `.env` file in your project root and add the following environment variables. You will need to provide your private key as a JSON array or Base58 encoded string and configure network URLs.

    ```env
    PRIVATE_KEY="[YOUR_SOLANA_PRIVATE_KEY_JSON_ARRAY]"
    BASE_IRYS_URL=https://devnet.irys.xyz
    BASE_ARWEAVE_URL=https://arweave.net
    CLUSTER=devnet
    ASSETS_PATH=./assets
    KEYPAIR_PATH=/home/chieftec/.config/solana/id.json
    ```

    *   Replace `[YOUR_SOLANA_PRIVATE_KEY_JSON_ARRAY]` with your Solana private key as a JSON array of numbers.
    *   `BASE_IRYS_URL`:  URL for Irys gateway (Devnet by default). For Mainnet use `https://mainnet.irys.xyz`.
    *   `BASE_ARWEAVE_URL`: URL for Arweave gateway (Devnet by default, Mainnet is `https://arweave.net`).
    *   `CLUSTER`: Solana network to use (`devnet`, `testnet`, or `mainnet-beta`).
    *   `ASSETS_PATH`: Path to your assets folder (images and metadata).
    *   `KEYPAIR_PATH`: Path to your Solana keypair file.

4.  **Install Dependencies**:
    Install necessary packages using pnpm:

    ```bash
    pnpm add @metaplex-foundation/umi@latest @solana/web3.js
    pnpm add @metaplex-foundation/mpl-token-metadata
    pnpm add @metaplex-foundation/umi-bundle-defaults
    pnpm add @metaplex-foundation/mpl-token-auth-rules
    pnpm add @solana/spl-token
    pnpm add @solana-developers/helpers   
    pnpm add @solana/web3.js
    pnpm add @irys/upload
    pnpm add @irys/upload-solana
    pnpm add arweave
    pnpm add @types/node
    pnpm add dotenv   
    pnpm add esrun
    pnpm add bs58
    pnpm add -D ts-node
    ```

    After adding all packages, install project dependencies:
    ```bash
    pnpm install
    ```

## Usage

This project includes scripts to upload assets, create a collection NFT, create individual NFTs, and verify NFTs.

### 1. Upload Assets to Irys

Run `1-irys-uploads.ts` to upload images and metadata to Irys and Arweave. This script will:

*   Read image and metadata files from `./assets/images/collection`, `./assets/metadata/collection`, `./assets/images/nfts`, and `./assets/metadata/nfts` folders.
*   Upload files to Irys.
*   Update metadata files with Irys URLs for images and metadata.

Run the script:

```bash
npx esrun 1-irys-upload.ts
```

Alternatively, specify the network directly:

```bash
CLUSTER=devnet npx esrun 1-irys-uploads.ts
```

After successful upload, you will receive transaction IDs. You can check the uploaded files via the gateways:

*   **Irys (Devnet and Mainnet):** `https://gateway.irys.xyz/[transaction-id]`

### 2. Upload Assets to Arweave

Run `1-arweave-uploads.ts` to upload images and metadata to Irys and Arweave. This script will:

*   Read image and metadata files from `./assets/images/collection`, `./assets/metadata/collection`, `./assets/images/nfts`, and `./assets/metadata/nfts` folders.
*   Upload files to Arweave (mainnet only).
*   Update metadata files with Arweave URLs for images and metadata.

Run the script:

```bash
npx esrun 1-arweave-uploads.ts
```

Alternatively, specify the network directly:

```bash
CLUSTER=devnet npx esrun 1-arweave-uploads.ts
```

After successful upload, you will receive transaction IDs. You can check the uploaded files via the gateways:

*   **Arweave (Mainnet):** `https://arweave.net/[transaction-id]`

### 3. Create RuleSet for Programmable NFTs (pNFTs)

Run `2-create-ruleset.ts` to create a ruleset for Programmable NFTs on Solana. This script will:

*   Read ruleset metadata from `./assets/cache`.
*   Create a RuleSet to Programmable NFT (pNFT) if not existing
*   Save the ruleseth address to `./assets/cache/ruleset-address.json`.

Run the script:

```bash
npx esrun 2-create-ruleset.ts
```

Alternatively, specify the network directly:

```bash
CLUSTER=devnet npx esrun 2-create-ruleset.ts
```

### 4. Create Collection NFT

Run `3-create-collection.ts` to create a collection NFT on Solana. This script will:

*   Read collection metadata from `./assets/metadata/collection`.
*   Create a Programmable NFT (pNFT) as a collection with defined Rule Set.
*   Save the collection address to `./assets/cache/collection-address.json`.

Run the script:

```bash
npx esrun 3-create-collection.ts
```

Alternatively, specify the network directly:

```bash
CLUSTER=devnet npx esrun 3-create-collection.ts
```

### 5. Create Individual NFTs

Run `4-create-pnfts.ts` to create individual NFTs and associate them with the created collection. This script will:

*   Read NFT metadata from `./assets/metadata/nfts`.
*   Create Programmable NFTs (pNFTs) for each metadata file.
*   Optionally associate each NFT with the collection created in step 2.
*   Save minted NFT addresses to `./assets/cache/nft-addresses.json`.

Run the script:

```bash
npx esrun 4-create-pnfts.ts
```

Alternatively, specify the network directly:

```bash
CLUSTER=devnet npx esrun 4-create-pnfts.ts
```

### 6. Verify NFTs

Run `5-verify-pnfts.ts` to verify the created NFTs as members of the collection. This script will:

*   Read collection and NFT addresses from cache files in `./assets/cache`.
*   Verify the collection NFT (if it's a regular NFT, verification for pNFT collections is skipped as `verifyCollection` is not supported for pNFT collections).
*   Verify each individual NFT as a member of the specified collection (verification for individual pNFTs is skipped).

Run the script:

```bash
npx esrun 5-verify-pnfts.ts
```

Alternatively, specify the network directly:

```bash
CLUSTER=devnet npx esrun 5-verify-pnfts.ts
```

## Deploy to Mainnet

To deploy your project to Mainnet-beta with real Solana and Arweave, follow these steps:

1.  **Create a New Mainnet Wallet**:
    Generate a new Solana keypair for Mainnet:
    ```bash
    solana-keygen new --outfile ~/.config/solana/id.json
    ```
    Verify the address: `solana address`

2.  **Configure Solana for Mainnet**:
    Set Solana CLI to Mainnet-beta:
    ```bash
    solana config set --url https://api.mainnet-beta.solana.com
    ```
    Verify configuration: `solana config get`

3.  **Fund Your Wallet with SOL**:
    Purchase Solana (SOL) from an exchange and transfer it to your Mainnet wallet address.

4.  **Set Up Arweave Wallet (Optional, if needed)**:
    Arweave may require a separate wallet depending on the service you are using. Set up an Arweave wallet if necessary.

5.  **Update Environment Variables**:
    Modify your `.env` file for Mainnet:

    ```env
    PRIVATE_KEY="[YOUR_MAINNET_PRIVATE_KEY_JSON_ARRAY]"
    BASE_IRYS_URL=https://mainnet.irys.xyz
    BASE_ARWEAVE_URL=https://arweave.net
    CLUSTER=mainnet-beta
    ```
    *   Replace `[YOUR_MAINNET_PRIVATE_KEY_JSON_ARRAY]` with your Mainnet private key.
    *   Ensure `BASE_IRYS_URL`, `BASE_ARWEAVE_URL`, and `CLUSTER` are set to Mainnet values.

6.  **Review and Update Code**:
    Double-check that your code points to the correct URLs and network configurations.

7.  **Test with Small Resources**:
    Start with a small test upload to verify everything works on Mainnet before processing larger assets.

8.  **Backup Keys**:
    Securely store your private keys and avoid sharing them. Consider using a hardware wallet for enhanced security.

9.  **Transfer from Devnet to Mainnet**:
    Repeat the deployment process on Mainnet using the updated configurations and Mainnet resources.

**Important Tips for Mainnet Deployment:**

*   **Gas Costs**: Ensure you have enough SOL in your wallet to cover transaction fees.
*   **Arweave Upload Fees**: Make sure your Arweave wallet (if used) has sufficient funds for permanent storage.
*   **Thorough Testing**: Test everything carefully before committing to large-scale deployments on Mainnet.

## File Descriptions

*   **`0-convert-secret.ts`**: Converts a Solana secret key from Base58 format to a JSON array and saves it to a configuration file.
*   **`0-read-wallet.ts`**: Reads a Solana wallet file and outputs the Base58 private key.
*   **`1-arweave-uploads.ts`**: Uploads images and metadata files to Arweave. It handles uploading collection and NFT assets, and updating local metadata files with uploaded URLs.
*   **`1-irys-uploads.ts`**: Uploads images and metadata files to Irys. It handles funding the Irys node, uploading collection and NFT assets, and updating local metadata files with uploaded URLs.
*   **`2-create-ruleset.ts`**: Creates a Rule Set for enforcing royalties on Solana pNFTs. Checks if a Rule Set already exists; if not, it creates a new one with specified operations and permissions.
*   **`3-create-collection.ts`**: Creates a Solana Programmable NFT (pNFT) to represent the NFT collection. It defines a Rule Set and mints the collection pNFT, saving its address to a cache file.
*   **`4-create-pnfts.ts`**: Creates individual Solana Programmable NFTs (pNFTs) for each metadata file in the `assets/metadata/nfts` directory. It associates them with the collection pNFT created by `3-create-collection.ts` and saves their addresses to a cache file.
*   **`5-verify-pnfts.ts`**: Verifies the created collection NFT and individual NFTs as members of the collection on the Solana blockchain. It skips verification for Programmable NFT collections and individual pNFTs due to current limitations of the `verifyCollection` instruction for pNFTs.
*   **`6-burn-pnft.ts`**: Burns a specified Solana Programmable NFT (pNFT), returning a portion of the mint cost (about half the cost).

## Troubleshooting

*   **"VS Code Server for WSL closed unexpectedly"**: Run `wsl --shutdown` and then `wsl` in PowerShell.
*   **`.env` file not working**: Ensure `.env` file is in the project root and that your environment is correctly loading it. You can also try creating the `.env` file manually if issues persist.
*   **Mismatched NFT images and metadata**: Ensure you have a corresponding metadata file (JSON) for each image file in the `assets/images/nfts` and `assets/metadata/nfts` folders.

## Useful Links

*   **Irys Gateway (Devnet):** [https://gateway.irys.xyz/](https://gateway.irys.xyz/)
*   **Arweave Gateway (Mainnet-beta):** [https://arweave.net/](https://arweave.net/)
*   **Solscan (Devnet):** [https://solscan.io?cluster=devnet](https://solscan.io/?cluster=devnet)
*   **Solscan (Mainnet-beta):** [https://solscan.io/](https://solscan.io/)
*   **Solana Explorer (Devnet):** [https://explorer.solana.com/?cluster=devnet](https://explorer.solana.com/?cluster=devnet)
*   **Solana Explorer (Mainnet-beta):** [https://explorer.solana.com/](https://explorer.solana.com/)

---

This README provides a comprehensive guide to setting up, deploying, and verifying your Solana NFT project. Ensure to follow each step carefully and adapt configurations as needed for your specific project requirements.
```