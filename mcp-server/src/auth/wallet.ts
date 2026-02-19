/**
 * Wallet management — derives ethers.Wallet from seed phrase,
 * computes CREATE2 Polymarket proxy address.
 *
 * Ported from CLOBClient.ts static methods to standalone Node.js module.
 */

import { ethers } from 'ethers';
import { appConfig } from '../config.js';

// ─── Constants (matching CLOBClient.ts) ──────────────────────

/** Polymarket Proxy Wallet Factory on Polygon mainnet */
const PROXY_FACTORY = '0xaB45c5A4B0c941a2F231C04C3f49182e1A254052';

/** Proxy implementation (verified deployed impl) */
const PROXY_IMPLEMENTATION = '0x44e999d5c2F66Ef0861317f9A4805AC2e90aEB4f';

// ─── Wallet Setup ────────────────────────────────────────────

export interface WalletInfo {
  wallet: ethers.HDNodeWallet;
  signerAddress: string;
  proxyAddress: string;
  signatureType: number;
}

/**
 * Create an ethers.Wallet from the seed phrase in config,
 * compute the Polymarket proxy address, and determine signature type.
 *
 * Returns null if no seed phrase is configured.
 */
export function initWallet(): WalletInfo | null {
  const seed = appConfig.walletSeedPhrase;
  if (!seed) return null;

  const wallet = ethers.Wallet.fromPhrase(seed);
  const signerAddress = wallet.address;
  const proxyAddress = computePolyProxyAddress(signerAddress);

  // Signature type: explicit override > proxy default
  let signatureType: number;
  if (appConfig.signatureTypeOverride !== null) {
    signatureType = appConfig.signatureTypeOverride;
  } else {
    // Standard: type 1 (POLY_PROXY) when proxy exists
    signatureType = 1;
  }

  process.stderr.write(
    `[wallet] Signer: ${signerAddress}\n` +
    `[wallet] Proxy: ${proxyAddress}\n` +
    `[wallet] SignatureType: ${signatureType}\n`,
  );

  return { wallet, signerAddress, proxyAddress, signatureType };
}

// ─── CREATE2 Proxy Computation ───────────────────────────────

/**
 * Compute the deterministic Polymarket proxy wallet address for a signer EOA.
 *
 * Replicates the on-chain PolyProxyLib.getProxyWalletAddress():
 *   salt = keccak256(abi.encodePacked(signer))
 *   creationCode = assembly-built minimal proxy + cloneConstructor("0x")
 */
export function computePolyProxyAddress(signerAddress: string): string {
  // Salt = keccak256(abi.encodePacked(signer))
  const salt = ethers.keccak256(ethers.solidityPacked(['address'], [signerAddress]));

  // Build creation code matching PolyProxyLib._computeCreationCode assembly
  const factoryLower = PROXY_FACTORY.slice(2).toLowerCase();
  const implLower = PROXY_IMPLEMENTATION.slice(2).toLowerCase();

  const bufHex =
    '3d3d606380380380913d393d73' +
    factoryLower +
    '5af4602a57600080fd5b602d8060366000396000f3363d3d373d3d3d363d73' +
    implLower +
    '5af43d82803e903d91602b57fd5bf3';

  // Append cloneConstructor(bytes) calldata with empty bytes arg
  const iface = new ethers.Interface(['function cloneConstructor(bytes)']);
  const consData = iface.encodeFunctionData('cloneConstructor', ['0x']);

  const creationCode = ethers.concat([
    ethers.getBytes('0x' + bufHex),
    ethers.getBytes(consData),
  ]);
  const bytecodeHash = ethers.keccak256(creationCode);

  return ethers.getCreate2Address(PROXY_FACTORY, salt, bytecodeHash);
}
