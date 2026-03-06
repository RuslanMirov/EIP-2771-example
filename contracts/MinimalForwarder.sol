// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  MinimalForwarder
 * @notice EIP-2771 Trusted Forwarder.
 *
 *  Meta-tx lifecycle
 *  ─────────────────
 *  1. Owner constructs a ForwardRequest and signs it with EIP-712
 *     typed-data (off-chain, zero gas).
 *  2. Any relayer calls execute(request, signature) and pays the gas.
 *  3. This contract verifies the signature, bumps the nonce, then
 *     calls the target with  [original calldata ++ owner_address].
 *  4. The target reads _msgSender() → last 20 bytes of calldata = owner.
 */
contract MinimalForwarder {

    // ────────────────────────────────────────────────────────────────────────
    //  EIP-712 type hashes
    // ────────────────────────────────────────────────────────────────────────

    bytes32 private constant _DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain("
            "string name,"
            "string version,"
            "uint256 chainId,"
            "address verifyingContract"
        ")"
    );

    bytes32 private constant _REQUEST_TYPEHASH = keccak256(
        "ForwardRequest("
            "address from,"
            "address to,"
            "uint256 value,"
            "uint256 gas,"
            "uint256 nonce,"
            "bytes data"
        ")"
    );

    bytes32 public immutable DOMAIN_SEPARATOR;

    constructor() {
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            _DOMAIN_TYPEHASH,
            keccak256(bytes("MinimalForwarder")),
            keccak256(bytes("1")),
            block.chainid,
            address(this)
        ));
    }

    // ────────────────────────────────────────────────────────────────────────
    //  ForwardRequest
    // ────────────────────────────────────────────────────────────────────────

    struct ForwardRequest {
        address from;    // original signer (owner)
        address to;      // target contract
        uint256 value;   // msg.value to forward
        uint256 gas;     // gas limit for inner call
        uint256 nonce;   // replay protection
        bytes   data;    // encoded call
    }

    // ────────────────────────────────────────────────────────────────────────
    //  Nonces
    // ────────────────────────────────────────────────────────────────────────

    mapping(address => uint256) private _nonces;

    /// @notice Current nonce for `signer`.  Include this in ForwardRequest.
    function getNonce(address signer) external view returns (uint256) {
        return _nonces[signer];
    }

    // ────────────────────────────────────────────────────────────────────────
    //  Verification
    // ────────────────────────────────────────────────────────────────────────

    /// @notice Off-chain pre-check: returns true iff signature is valid & nonce matches.
    function verify(ForwardRequest calldata req, bytes calldata sig)
        public view returns (bool)
    {
        return _nonces[req.from] == req.nonce
            && _recover(req, sig) == req.from;
    }

    // ────────────────────────────────────────────────────────────────────────
    //  Execute
    // ────────────────────────────────────────────────────────────────────────

    /**
     * @notice Relay a signed meta-transaction.
     * @dev    Callable by anyone — the relayer pays gas; the owner pays nothing.
     *
     * @param req  The ForwardRequest that the owner signed.
     * @param sig  65-byte ECDSA signature (EIP-712 typed-data).
     *
     * @return success     Whether the inner call succeeded.
     * @return returndata  Return-data from the inner call.
     */
    function execute(ForwardRequest calldata req, bytes calldata sig)
        external payable
        returns (bool success, bytes memory returndata)
    {
        require(verify(req, sig), "Forwarder: bad signature or nonce");
        require(msg.value == req.value, "Forwarder: wrong ETH value");

        // Consume nonce — prevents replay.
        unchecked { _nonces[req.from]++; }

        // EIP-2771: append req.from to calldata so target can recover real sender.
        (success, returndata) = req.to.call{gas: req.gas, value: req.value}(
            abi.encodePacked(req.data, req.from)
        );

        // Bubble revert reason if present.
        if (!success) {
            if (returndata.length > 0) {
                assembly { revert(add(returndata, 32), mload(returndata)) }
            }
            revert("Forwarder: call reverted silently");
        }
    }

    // ────────────────────────────────────────────────────────────────────────
    //  Internal: EIP-712 hash + ecrecover
    // ────────────────────────────────────────────────────────────────────────

    function _hash(ForwardRequest calldata req) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(
            "\x19\x01",
            DOMAIN_SEPARATOR,
            keccak256(abi.encode(
                _REQUEST_TYPEHASH,
                req.from,
                req.to,
                req.value,
                req.gas,
                req.nonce,
                keccak256(req.data)
            ))
        ));
    }

    function _recover(ForwardRequest calldata req, bytes calldata sig)
        internal view returns (address)
    {
        require(sig.length == 65, "Forwarder: sig length != 65");
        bytes32 r; bytes32 s; uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        return ecrecover(_hash(req), v, r, s);
    }
}
