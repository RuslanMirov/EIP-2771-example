// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ────────────────────────────────────────────────────────────────────────────
//  ERC-2771 context mixin
// ────────────────────────────────────────────────────────────────────────────

/**
 * @title  ERC2771Context
 * @notice Resolves the real transaction originator when called via a
 *         trusted EIP-2771 forwarder.
 *
 * Calldata layout when forwarded:
 *   [ selector 4B ][ args... ][ original_sender 20B ]
 *
 * When msg.sender IS the trusted forwarder the last 20 bytes of calldata
 * hold the original signer's address; otherwise msg.sender is used.
 */
abstract contract ERC2771Context {

    address private immutable _trustedForwarder;

    constructor(address forwarder) {
        require(forwarder != address(0), "Context: zero forwarder");
        _trustedForwarder = forwarder;
    }

    /// @notice Returns true if `forwarder` is the registered trusted forwarder.
    function isTrustedForwarder(address forwarder) public view returns (bool) {
        return forwarder == _trustedForwarder;
    }

    /// @notice The "real" sender: original signer (via forwarder) or msg.sender.
    function _msgSender() internal view virtual returns (address sender) {
        if (isTrustedForwarder(msg.sender) && msg.data.length >= 20) {
            // solhint-disable-next-line no-inline-assembly
            assembly {
                sender := shr(96, calldataload(sub(calldatasize(), 20)))
            }
        } else {
            sender = msg.sender;
        }
    }

    /// @notice Calldata without the appended sender suffix.
    function _msgData() internal view virtual returns (bytes calldata) {
        if (isTrustedForwarder(msg.sender) && msg.data.length >= 20) {
            return msg.data[:msg.data.length - 20];
        }
        return msg.data;
    }
}

// ────────────────────────────────────────────────────────────────────────────
//  SecureVault — owner-only state, supports meta-transactions
// ────────────────────────────────────────────────────────────────────────────

/**
 * @title  SecureVault
 * @notice Demonstrates EIP-2771:
 *         • Only the owner may mutate state.
 *         • Owner signs off-chain; a relayer submits & pays gas.
 *         • _msgSender() resolves the true caller through the forwarder.
 *
 * State variables
 * ───────────────
 *   counter    – incremented by owner on every write
 *   label      – arbitrary string set by owner
 *   balance    – ETH deposited through meta-tx (req.value path)
 */
contract SecureVault is ERC2771Context {

    // ── State ────────────────────────────────────────────────────────────────

    address public owner;

    uint256 public counter;
    string  public label;
    uint256 public totalUpdates;

    // ── Events ───────────────────────────────────────────────────────────────

    event CounterSet(address indexed by, uint256 oldValue, uint256 newValue);
    event LabelSet  (address indexed by, string  oldLabel, string  newLabel);
    event Deposited (address indexed by, uint256 amount);
    event Withdrawn (address indexed to, uint256 amount);
    event OwnershipTransferred(address indexed previous, address indexed next);

    // ── Errors ───────────────────────────────────────────────────────────────

    error NotOwner(address caller);
    error ZeroAddress();
    error InsufficientBalance(uint256 requested, uint256 available);

    // ── Modifier ─────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        address sender = _msgSender();
        if (sender != owner) revert NotOwner(sender);
        _;
    }

    // ── Constructor ──────────────────────────────────────────────────────────

    /**
     * @param forwarder  Address of the deployed MinimalForwarder.
     *                   Passed to ERC2771Context so _msgSender() works.
     */
    constructor(address forwarder) ERC2771Context(forwarder) {
        owner = msg.sender;   // deployer is initial owner
    }

    // ── Owner-only mutations ─────────────────────────────────────────────────

    /**
     * @notice Set the counter to `newValue`.
     *         Can be called directly by owner *or* via a signed meta-tx.
     */
    function setCounter(uint256 newValue) external onlyOwner {
        uint256 old = counter;
        counter = newValue;
        totalUpdates++;
        emit CounterSet(_msgSender(), old, newValue);
    }

    /**
     * @notice Set the label string.
     *         Can be called directly by owner *or* via a signed meta-tx.
     */
    function setLabel(string calldata newLabel) external onlyOwner {
        string memory old = label;
        label = newLabel;
        totalUpdates++;
        emit LabelSet(_msgSender(), old, newLabel);
    }

    /**
     * @notice Transfer ownership to `newOwner`.
     */
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ── ETH flow (optional, shows value forwarding works too) ────────────────

    /// @notice Deposit ETH via meta-tx or direct call.
    function deposit() external payable onlyOwner {
        emit Deposited(_msgSender(), msg.value);
    }

    /// @notice Withdraw ETH to `to`.
    function withdraw(address payable to, uint256 amount) external onlyOwner {
        if (amount > address(this).balance)
            revert InsufficientBalance(amount, address(this).balance);
        emit Withdrawn(to, amount);
        (bool ok,) = to.call{value: amount}("");
        require(ok, "Vault: ETH transfer failed");
    }

    // ── View ─────────────────────────────────────────────────────────────────

    function getState() external view returns (
        address _owner,
        uint256 _counter,
        string memory _label,
        uint256 _totalUpdates,
        uint256 _vaultBalance
    ) {
        return (owner, counter, label, totalUpdates, address(this).balance);
    }

    receive() external payable {}
}
