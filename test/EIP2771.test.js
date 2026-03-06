// test/EIP2771.test.cjs
const { expect }  = require("chai");
const { ethers }  = require("hardhat");

// ─────────────────────────────────────────────────────────────────────────────
//  EIP-712 signing helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build and sign a ForwardRequest.
 *
 * @param {object} p
 * @param {Contract} p.forwarder
 * @param {Signer}   p.signer    - the owner (signs, pays no gas)
 * @param {string}   p.to        - target contract address
 * @param {string}   p.data      - encoded calldata
 * @param {bigint}   [p.value]
 * @param {bigint}   [p.gas]
 * @param {bigint}   [p.chainId]
 */
async function buildMetaTx({ forwarder, signer, to, data, value = 0n, gas = 500_000n, chainId }) {
  const nonce = await forwarder.getNonce(signer.address);

  const domain = {
    name:              "MinimalForwarder",
    version:           "1",
    chainId,
    verifyingContract: await forwarder.getAddress(),
  };

  const types = {
    ForwardRequest: [
      { name: "from",  type: "address" },
      { name: "to",   type: "address"  },
      { name: "value",type: "uint256"  },
      { name: "gas",  type: "uint256"  },
      { name: "nonce",type: "uint256"  },
      { name: "data", type: "bytes"    },
    ],
  };

  const message = { from: signer.address, to, value, gas, nonce, data };
  const signature = await signer.signTypedData(domain, types, message);

  return { request: message, signature };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe("EIP-2771  ·  MinimalForwarder + SecureVault", function () {

  let forwarder, vault;
  let owner, relayer, alice, attacker;
  let chainId;

  // ── Fixtures ──────────────────────────────────────────────────────────────

  beforeEach(async () => {
    [owner, relayer, alice, attacker] = await ethers.getSigners();
    chainId = (await ethers.provider.getNetwork()).chainId;

    const Forwarder = await ethers.getContractFactory("MinimalForwarder");
    forwarder = await Forwarder.deploy();

    const Vault = await ethers.getContractFactory("SecureVault");
    vault = await Vault.deploy(await forwarder.getAddress());

    // owner == deployer already; just confirm
    expect(await vault.owner()).to.equal(owner.address);
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  1. DEPLOYMENT
  // ══════════════════════════════════════════════════════════════════════════

  describe("1. Deployment", () => {
    it("forwarder stores correct domain separator", async () => {
      const ds = await forwarder.DOMAIN_SEPARATOR();
      expect(ds).to.be.a("string").with.length(66); // 0x + 64 hex chars
    });

    it("vault owner == deployer", async () => {
      expect(await vault.owner()).to.equal(owner.address);
    });

    it("vault recognises the forwarder as trusted", async () => {
      expect(await vault.isTrustedForwarder(await forwarder.getAddress())).to.be.true;
    });

    it("vault does NOT trust arbitrary addresses", async () => {
      expect(await vault.isTrustedForwarder(alice.address)).to.be.false;
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  2. DIRECT CALLS (baseline — owner calls vault directly)
  // ══════════════════════════════════════════════════════════════════════════

  describe("2. Direct calls (owner pays gas)", () => {
    it("owner can setCounter directly", async () => {
      await vault.connect(owner).setCounter(99n);
      expect(await vault.counter()).to.equal(99n);
    });

    it("owner can setLabel directly", async () => {
      await vault.connect(owner).setLabel("hello");
      expect(await vault.label()).to.equal("hello");
    });

    it("non-owner setCounter reverts with NotOwner", async () => {
      await expect(vault.connect(attacker).setCounter(1n))
        .to.be.revertedWithCustomError(vault, "NotOwner")
        .withArgs(attacker.address);
    });

    it("non-owner setLabel reverts with NotOwner", async () => {
      await expect(vault.connect(attacker).setLabel("hack"))
        .to.be.revertedWithCustomError(vault, "NotOwner")
        .withArgs(attacker.address);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  3. META-TRANSACTIONS (owner signs, relayer pays gas)
  // ══════════════════════════════════════════════════════════════════════════

  describe("3. Meta-transactions (relayer pays gas)", () => {

    // ── 3a. setCounter via meta-tx ─────────────────────────────────────────

    describe("3a. setCounter via meta-tx", () => {
      it("relayer can relay a valid setCounter signed by owner", async () => {
        const data = vault.interface.encodeFunctionData("setCounter", [42n]);
        const { request, signature } = await buildMetaTx({
          forwarder, signer: owner, to: await vault.getAddress(), data, chainId,
        });

        // verify returns true before execution
        expect(await forwarder.verify(request, signature)).to.be.true;

        // snapshot balances
        const ownerBefore   = await ethers.provider.getBalance(owner.address);
        const relayerBefore = await ethers.provider.getBalance(relayer.address);

        const tx      = await forwarder.connect(relayer).execute(request, signature);
        const receipt = await tx.wait();

        const ownerAfter   = await ethers.provider.getBalance(owner.address);
        const relayerAfter = await ethers.provider.getBalance(relayer.address);

        // state updated
        expect(await vault.counter()).to.equal(42n);
        expect(await vault.totalUpdates()).to.equal(1n);

        // owner paid nothing
        expect(ownerAfter).to.equal(ownerBefore);

        // relayer paid gas
        const gasCost = receipt.gasUsed * tx.gasPrice;
        expect(relayerAfter).to.equal(relayerBefore - gasCost);
      });

      it("emits CounterSet with owner as `by` (not relayer)", async () => {
        const data = vault.interface.encodeFunctionData("setCounter", [7n]);
        const { request, signature } = await buildMetaTx({
          forwarder, signer: owner, to: await vault.getAddress(), data, chainId,
        });

        await expect(forwarder.connect(relayer).execute(request, signature))
          .to.emit(vault, "CounterSet")
          .withArgs(owner.address, 0n, 7n);
      });
    });

    // ── 3b. setLabel via meta-tx ───────────────────────────────────────────

    describe("3b. setLabel via meta-tx", () => {
      it("relayer can relay setLabel signed by owner", async () => {
        const data = vault.interface.encodeFunctionData("setLabel", ["EIP-2771"]);
        const { request, signature } = await buildMetaTx({
          forwarder, signer: owner, to: await vault.getAddress(), data, chainId,
        });

        await forwarder.connect(relayer).execute(request, signature);
        expect(await vault.label()).to.equal("EIP-2771");
      });

      it("emits LabelSet with owner as `by`", async () => {
        const data = vault.interface.encodeFunctionData("setLabel", ["meta"]);
        const { request, signature } = await buildMetaTx({
          forwarder, signer: owner, to: await vault.getAddress(), data, chainId,
        });

        await expect(forwarder.connect(relayer).execute(request, signature))
          .to.emit(vault, "LabelSet")
          .withArgs(owner.address, "", "meta");
      });
    });

    // ── 3c. Multiple sequential meta-txs ──────────────────────────────────

    describe("3c. Sequential meta-txs", () => {
      it("nonce increments correctly across multiple relays", async () => {
        const fwdAddr = await vault.getAddress();

        for (let i = 1; i <= 3; i++) {
          const data = vault.interface.encodeFunctionData("setCounter", [BigInt(i * 10)]);
          const { request, signature } = await buildMetaTx({
            forwarder, signer: owner, to: fwdAddr, data, chainId,
          });
          await forwarder.connect(relayer).execute(request, signature);
        }

        expect(await vault.counter()).to.equal(30n);
        expect(await forwarder.getNonce(owner.address)).to.equal(3n);
        expect(await vault.totalUpdates()).to.equal(3n);
      });
    });

  }); // 3. Meta-transactions

  // ══════════════════════════════════════════════════════════════════════════
  //  4. SECURITY: REPLAY PROTECTION
  // ══════════════════════════════════════════════════════════════════════════

  describe("4. Replay protection", () => {
    it("replaying the same signature reverts", async () => {
      const data = vault.interface.encodeFunctionData("setCounter", [1n]);
      const { request, signature } = await buildMetaTx({
        forwarder, signer: owner, to: await vault.getAddress(), data, chainId,
      });

      await forwarder.connect(relayer).execute(request, signature);

      await expect(forwarder.connect(relayer).execute(request, signature))
        .to.be.revertedWith("Forwarder: bad signature or nonce");
    });

    it("verify returns false for a stale (already-used) nonce", async () => {
      const data = vault.interface.encodeFunctionData("setCounter", [2n]);
      const { request, signature } = await buildMetaTx({
        forwarder, signer: owner, to: await vault.getAddress(), data, chainId,
      });

      await forwarder.connect(relayer).execute(request, signature);

      expect(await forwarder.verify(request, signature)).to.be.false;
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  5. SECURITY: SIGNATURE FORGERY
  // ══════════════════════════════════════════════════════════════════════════

  describe("5. Signature forgery", () => {
    it("attacker signing with own key but claiming from=owner is rejected", async () => {
      const data  = vault.interface.encodeFunctionData("setCounter", [666n]);
      const nonce = await forwarder.getNonce(owner.address);

      const forgery = {
        from:  owner.address,       // ← lying about sender
        to:    await vault.getAddress(),
        value: 0n,
        gas:   500_000n,
        nonce,
        data,
      };

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

      // attacker signs with their OWN private key
      const badSig = await attacker.signTypedData(domain, types, forgery);

      await expect(forwarder.connect(relayer).execute(forgery, badSig))
        .to.be.revertedWith("Forwarder: bad signature or nonce");

      // state unchanged
      expect(await vault.counter()).to.equal(0n);
    });

    it("calling vault directly as relayer is rejected by onlyOwner", async () => {
      await expect(vault.connect(relayer).setCounter(999n))
        .to.be.revertedWithCustomError(vault, "NotOwner")
        .withArgs(relayer.address);
    });

    it("sig with wrong nonce is rejected even if ECDSA is valid", async () => {
      const data = vault.interface.encodeFunctionData("setCounter", [1n]);

      // build with nonce + 5 (wrong)
      const futureNonce = (await forwarder.getNonce(owner.address)) + 5n;
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
      const req = {
        from: owner.address, to: await vault.getAddress(),
        value: 0n, gas: 500_000n, nonce: futureNonce, data,
      };
      const sig = await owner.signTypedData(domain, types, req);

      await expect(forwarder.connect(relayer).execute(req, sig))
        .to.be.revertedWith("Forwarder: bad signature or nonce");
    });

    it("truncated signature reverts", async () => {
      const data = vault.interface.encodeFunctionData("setCounter", [1n]);
      const { request, signature } = await buildMetaTx({
        forwarder, signer: owner, to: await vault.getAddress(), data, chainId,
      });

      const badSig = signature.slice(0, -2); // remove last byte
      await expect(forwarder.connect(relayer).execute(request, badSig))
        .to.be.reverted;
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  6. OWNERSHIP TRANSFER (also via meta-tx)
  // ══════════════════════════════════════════════════════════════════════════

  describe("6. Ownership transfer", () => {
    it("owner can transfer ownership directly", async () => {
      await vault.connect(owner).transferOwnership(alice.address);
      expect(await vault.owner()).to.equal(alice.address);
    });

    it("new owner can mutate state after transfer", async () => {
      await vault.connect(owner).transferOwnership(alice.address);
      await vault.connect(alice).setCounter(55n);
      expect(await vault.counter()).to.equal(55n);
    });

    it("old owner is locked out after transfer", async () => {
      await vault.connect(owner).transferOwnership(alice.address);
      await expect(vault.connect(owner).setCounter(1n))
        .to.be.revertedWithCustomError(vault, "NotOwner");
    });

    it("transferOwnership to zero address reverts", async () => {
      await expect(vault.connect(owner).transferOwnership(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(vault, "ZeroAddress");
    });

    it("owner can transfer ownership via meta-tx (relayer pays gas)", async () => {
      const data = vault.interface.encodeFunctionData("transferOwnership", [alice.address]);
      const { request, signature } = await buildMetaTx({
        forwarder, signer: owner, to: await vault.getAddress(), data, chainId,
      });
      await forwarder.connect(relayer).execute(request, signature);
      expect(await vault.owner()).to.equal(alice.address);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  7. GAS USAGE
  // ══════════════════════════════════════════════════════════════════════════

  describe("7. Gas benchmarks", () => {
    it("setCounter direct  < 100 000 gas", async () => {
      const tx = await vault.connect(owner).setCounter(1n);
      const r  = await tx.wait();
      console.log("    setCounter (direct)  :", r.gasUsed.toString(), "gas");
      expect(r.gasUsed).to.be.lt(100_000n);
    });

    it("setCounter meta-tx  < 200 000 gas", async () => {
      const data = vault.interface.encodeFunctionData("setCounter", [1n]);
      const { request, signature } = await buildMetaTx({
        forwarder, signer: owner, to: await vault.getAddress(), data, chainId,
      });
      const tx = await forwarder.connect(relayer).execute(request, signature);
      const r  = await tx.wait();
      console.log("    setCounter (meta-tx) :", r.gasUsed.toString(), "gas");
      expect(r.gasUsed).to.be.lt(200_000n);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  8. getState view
  // ══════════════════════════════════════════════════════════════════════════

  describe("8. getState()", () => {
    it("returns consistent state after multiple meta-txs", async () => {
      const fwdAddr = await vault.getAddress();

      const d1 = vault.interface.encodeFunctionData("setCounter", [99n]);
      const r1 = await buildMetaTx({ forwarder, signer: owner, to: fwdAddr, data: d1, chainId });
      await forwarder.connect(relayer).execute(r1.request, r1.signature);

      const d2 = vault.interface.encodeFunctionData("setLabel", ["done"]);
      const r2 = await buildMetaTx({ forwarder, signer: owner, to: fwdAddr, data: d2, chainId });
      await forwarder.connect(relayer).execute(r2.request, r2.signature);

      const [_owner, _counter, _label, _updates] = await vault.getState();
      expect(_owner).to.equal(owner.address);
      expect(_counter).to.equal(99n);
      expect(_label).to.equal("done");
      expect(_updates).to.equal(2n);
    });
  });

});
