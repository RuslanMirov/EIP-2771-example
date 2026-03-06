// scripts/compile.js
// Compiles contracts using the bundled solc (no network needed).
// Outputs Hardhat-compatible artifacts to artifacts/contracts/

const solc = require("solc");
const fs   = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

const sources = {
  "MinimalForwarder.sol": {
    content: fs.readFileSync(path.join(ROOT, "contracts/MinimalForwarder.sol"), "utf8"),
  },
  "SecureVault.sol": {
    content: fs.readFileSync(path.join(ROOT, "contracts/SecureVault.sol"), "utf8"),
  },
};

const input = JSON.stringify({
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode"] } },
  },
});

console.log("Compiling with solc", solc.version(), "...");
const output = JSON.parse(solc.compile(input));

const errors = (output.errors || []).filter((e) => e.severity === "error");
if (errors.length) {
  console.error("Compilation errors:\n", JSON.stringify(errors, null, 2));
  process.exit(1);
}

for (const [file, contracts] of Object.entries(output.contracts)) {
  for (const [name, data] of Object.entries(contracts)) {
    const dir = path.join(ROOT, "artifacts/contracts", file);
    fs.mkdirSync(dir, { recursive: true });

    const artifact = {
      _format:               "hh-sol-artifact-1",
      contractName:          name,
      sourceName:            file,
      abi:                   data.abi,
      bytecode:              "0x" + data.evm.bytecode.object,
      deployedBytecode:      "0x" + data.evm.deployedBytecode.object,
      linkReferences:        {},
      deployedLinkReferences:{},
    };

    const outPath = path.join(dir, `${name}.json`);
    fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));
    console.log("  ✓", name, "→", path.relative(ROOT, outPath));
  }
}

console.log("Done.");