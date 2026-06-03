#!/usr/bin/env node
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const kp = Keypair.generate();
const pubkey = kp.publicKey.toBase58();
const secret = bs58.encode(kp.secretKey);

console.log("");
console.log("=== Bot wallet keypair (KEEP SECRET) ===");
console.log(`Pubkey: ${pubkey}`);
console.log(`Secret (base58): ${secret}`);
console.log("");
console.log("Add to .env:");
console.log(`  WALLET_PRIVATE_KEY=${secret}`);
console.log("");
console.log("Legacy alias also supported:");
console.log(`  PRIVATE_KEY_BOT=${secret}`);
console.log("");

process.exit(0);
