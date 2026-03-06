// scripts/demo.cjs  —  EIP-2771 live demo on the Hardhat in-process network
"use strict";

const hre    = require("hardhat");
const ethers = hre.ethers;

// ── EIP-712 helper ────────────────────────────────────────────────────────────

async function buildMetaTx({ forwarder, signer, to, data, chainId, value = 0n, gas = 500_000n }) {
  const nonce  = await forwarder.getNonce(signer.address);
  const domain = {
    name: "MinimalForwarder", version: "1",
    chainId, verifyingContract: await forwarder.getAddress(),
  };
  const types = {
    ForwardRequest: [
      { name:"from",  type:"address" },
      { name:"to",   type:"address"  },
      { name:"value",type:"uint256"  },
      { name:"gas",  type:"uint256"  },
      { name:"nonce",type:"uint256"  },
      { name:"data", type:"bytes"    },
    ],
  };
  const message  = { from: signer.address, to, value, gas, nonce, data };
  const sig      = await signer.signTypedData(domain, types, message);
  return { request: message, sig };
}

const hr  = () => console.log("─".repeat(64));
const fmt = (wei) => parseFloat(ethers.formatEther(wei)).toFixed(6) + " ETH";

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const [deployer, owner, relayer, attacker] = await ethers.getSigners();
  const chainId = (await ethers.provider.getNetwork()).chainId;

  hr();
  console.log("  EIP-2771  ·  Meta-Transaction Demo");
  hr();
  console.log("  owner    :", owner.address);
  console.log("  relayer  :", relayer.address);
  console.log("  attacker :", attacker.address);

  // ── Deploy ──────────────────────────────────────────────────────────────────

  const Forwarder = await ethers.getContractFactory("MinimalForwarder");
  const forwarder = await Forwarder.deploy();
  await forwarder.waitForDeployment();

  const Vault = await ethers.getContractFactory("SecureVault");
  const vault = await Vault.deploy(await forwarder.getAddress());
  await vault.waitForDeployment();

  // Transfer vault ownership from deployer → owner
  await vault.connect(deployer).transferOwnership(owner.address);

  console.log("\n  Contracts:");
  console.log("    MinimalForwarder :", await forwarder.getAddress());
  console.log("    SecureVault      :", await vault.getAddress());
  console.log("    vault.owner()    :", await vault.owner());

  // ── Balances before ─────────────────────────────────────────────────────────

  const ob0 = await ethers.provider.getBalance(owner.address);
  const rb0 = await ethers.provider.getBalance(relayer.address);
  console.log("\n  Balances BEFORE:");
  console.log("    owner   :", fmt(ob0));
  console.log("    relayer :", fmt(rb0));

  // ── Meta-tx 1: setCounter(42) ───────────────────────────────────────────────

  console.log("\n  ① Owner signs setCounter(42) off-chain…");
  const d1 = vault.interface.encodeFunctionData("setCounter", [42n]);
  const mt1 = await buildMetaTx({ forwarder, signer: owner, to: await vault.getAddress(), data: d1, chainId });

  console.log("    verify →", await forwarder.verify(mt1.request, mt1.sig));

  console.log("  ① Relayer submits…");
  const tx1  = await forwarder.connect(relayer).execute(mt1.request, mt1.sig);
  const rc1  = await tx1.wait();
  console.log("    gasUsed :", rc1.gasUsed.toString());
  console.log("    counter :", (await vault.counter()).toString());

  const ob1 = await ethers.provider.getBalance(owner.address);
  const rb1 = await ethers.provider.getBalance(relayer.address);
  console.log("\n  Balances AFTER setCounter:");
  console.log("    owner   :", fmt(ob1), "  Δ", fmt(ob1 - ob0));
  console.log("    relayer :", fmt(rb1), "  Δ", fmt(rb1 - rb0));

  // ── Meta-tx 2: setLabel ─────────────────────────────────────────────────────

  console.log("\n  ② Owner signs setLabel('meta-tx rocks') off-chain…");
  const d2  = vault.interface.encodeFunctionData("setLabel", ["meta-tx rocks"]);
  const mt2 = await buildMetaTx({ forwarder, signer: owner, to: await vault.getAddress(), data: d2, chainId });
  await (await forwarder.connect(relayer).execute(mt2.request, mt2.sig)).wait();
  console.log("    label :", await vault.label());

  // ── Replay attack ───────────────────────────────────────────────────────────

  console.log("\n  ③ Replay attack with same signature…");
  try {
    await forwarder.connect(relayer).execute(mt1.request, mt1.sig);
    console.log("    ✗ Should have reverted!");
  } catch (e) {
    console.log("    ✓ Rejected:", e.reason ?? e.message.split("\n")[0]);
  }

  // ── Forgery attack ──────────────────────────────────────────────────────────

  console.log("\n  ④ Attacker forges request claiming from=owner…");
  const fakeData = vault.interface.encodeFunctionData("setCounter", [666n]);
  const nonce    = await forwarder.getNonce(owner.address);
  const domain   = { name:"MinimalForwarder", version:"1", chainId, verifyingContract: await forwarder.getAddress() };
  const types    = { ForwardRequest: [
    { name:"from",type:"address"},{ name:"to",type:"address"},
    { name:"value",type:"uint256"},{ name:"gas",type:"uint256"},
    { name:"nonce",type:"uint256"},{ name:"data",type:"bytes"},
  ]};
  const forgery  = { from: owner.address, to: await vault.getAddress(), value:0n, gas:500_000n, nonce, data: fakeData };
  const badSig   = await attacker.signTypedData(domain, types, forgery);
  try {
    await forwarder.connect(relayer).execute(forgery, badSig);
    console.log("    ✗ Should have reverted!");
  } catch (e) {
    console.log("    ✓ Rejected:", e.reason ?? e.message.split("\n")[0]);
  }

  // ── Final state ─────────────────────────────────────────────────────────────

  const [_owner, _counter, _label, _updates] = await vault.getState();
  console.log("\n  Final vault state:");
  console.log("    owner        :", _owner);
  console.log("    counter      :", _counter.toString());
  console.log("    label        :", _label);
  console.log("    totalUpdates :", _updates.toString());
  console.log("    nonce        :", (await forwarder.getNonce(owner.address)).toString());

  hr();
  console.log("  ✅  Owner paid ZERO gas.  All gas paid by relayer.");
  hr();
}

main().catch((e) => { console.error(e); process.exit(1); });
