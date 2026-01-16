// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

interface IPool {
  function flashLoanSimple(
    address receiverAddress,
    address asset,
    uint256 amount,
    bytes calldata params,
    uint16 referralCode
  ) external;

  function liquidationCall(
    address collateralAsset,
    address debtAsset,
    address user,
    uint256 debtToCover,
    bool receiveAToken
  ) external;
}

interface IFlashLoanSimpleReceiver {
  function executeOperation(
    address asset,
    uint256 amount,
    uint256 premium,
    address initiator,
    bytes calldata params
  ) external returns (bool);
}

interface ISwapRouter02 {
  struct ExactInputParams {
    bytes path;
    address recipient;
    uint256 deadline;
    uint256 amountIn;
    uint256 amountOutMinimum;
  }

  function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

///
/// LiquidationExecutor (The Reaper - Aave V3 Edition)
/// - Flashloans debt asset
/// - Liquidates on Aave V3
/// - Swaps collateral to debt asset
/// - Repays flashloan + premium
/// - Profits to treasury
///
contract LiquidationExecutor is IFlashLoanSimpleReceiver, Ownable2Step, Pausable, ReentrancyGuard, EIP712 {
  using SafeERC20 for IERC20;

  // -----------------------------
  // Errors
  // -----------------------------
  error ZeroAddress();
  error NotOperator();
  error BadCaller();
  error BadInitiator();
  error AssetMismatch();
  error AmountMismatch();
  error DeadlineExpired();
  error GasPriceTooHigh();
  error ProfitTooLow();
  error NoCollateral();
  error InvalidSignature();

  // -----------------------------
  // Events
  // -----------------------------
  event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
  event OperatorUpdated(address indexed operator, bool allowed);
  event OperatorModeUpdated(bool enabled);
  event SignerUpdated(address indexed oldSigner, address indexed newSigner);

  event Executed(
    address indexed executor,
    address indexed borrower,
    address indexed debtAsset,
    address collateralAsset,
    uint256 repayAmount,
    uint256 premium,
    uint256 collateralReceived,
    uint256 loanOutFromSwap,
    uint256 profit
  );

  // -----------------------------
  // Immutable core deps
  // -----------------------------
  IPool public immutable aavePool;
  ISwapRouter02 public immutable swapRouter;

  // -----------------------------
  // Config
  // -----------------------------
  address public treasury;

  // Operators allowlist
  bool public operatorModeEnabled = true;
  mapping(address => bool) public isOperator;

  // Optional: EIP-712 signer (keeper-mode)
  address public signer;
  mapping(uint256 => bool) public usedNonces;

  // -----------------------------
  // Order types
  // -----------------------------
  struct Order {
    address debtAsset;
    address collateralAsset;
    address borrower;
    uint256 repayAmount; // Amount to liquidate (debt to cover)

    // Uniswap V3 path collateral -> debtAsset
    bytes uniPath;

    // Slippage guard: min output in debtAsset
    uint256 amountOutMin;

    // Profit guardrail in debtAsset
    uint256 minProfit;

    uint256 deadline;
    uint256 maxTxGasPrice;
    uint16 referralCode;
    uint256 nonce;
  }

  struct CallbackData {
    Order order;
    address executor;
  }

  bytes32 private constant ORDER_TYPEHASH =
    keccak256(
      "Order(address debtAsset,address collateralAsset,address borrower,uint256 repayAmount,bytes32 uniPathHash,uint256 amountOutMin,uint256 minProfit,uint256 deadline,uint256 maxTxGasPrice,uint16 referralCode,uint256 nonce)"
    );

  // -----------------------------
  // Constructor
  // -----------------------------
  constructor(
    address _aavePool,
    address _swapRouter,
    address _treasury
  ) Ownable(msg.sender) EIP712("LiquidationExecutor", "1") {
    if (_aavePool == address(0) || _swapRouter == address(0) || _treasury == address(0)) {
      revert ZeroAddress();
    }
    aavePool = IPool(_aavePool);
    swapRouter = ISwapRouter02(_swapRouter);
    treasury = _treasury;

    isOperator[msg.sender] = true;
    emit OperatorUpdated(msg.sender, true);
  }

  // -----------------------------
  // Admin & Pausable
  // -----------------------------
  function setTreasury(address t) external onlyOwner {
    if (t == address(0)) revert ZeroAddress();
    emit TreasuryUpdated(treasury, t);
    treasury = t;
  }

  function setSigner(address s) external onlyOwner {
    emit SignerUpdated(signer, s);
    signer = s;
  }

  function setOperator(address op, bool allowed) external onlyOwner {
    if (op == address(0)) revert ZeroAddress();
    isOperator[op] = allowed;
    emit OperatorUpdated(op, allowed);
  }

  function setOperatorModeEnabled(bool enabled) external onlyOwner {
    operatorModeEnabled = enabled;
    emit OperatorModeUpdated(enabled);
  }

  function pause() external onlyOwner { _pause(); }
  function unpause() external onlyOwner { _unpause(); }

  // -----------------------------
  // Execution
  // -----------------------------
  modifier onlyOperator() {
    if (operatorModeEnabled && !isOperator[msg.sender]) revert NotOperator();
    if (!operatorModeEnabled && msg.sender != owner()) revert NotOperator();
    _;
  }

  function execute(Order calldata order) external onlyOperator whenNotPaused {
    _precheck(order);
    aavePool.flashLoanSimple(
      address(this),
      order.debtAsset,
      order.repayAmount,
      abi.encode(CallbackData({order: order, executor: msg.sender})),
      order.referralCode
    );
  }

  function executeWithSig(Order calldata order, bytes calldata signature) external whenNotPaused {
    if (signer == address(0)) revert InvalidSignature();
    _precheck(order);
    if (usedNonces[order.nonce]) revert InvalidSignature();
    usedNonces[order.nonce] = true;

    bytes32 digest = _hashTypedDataV4(_hashOrder(order));
    if (ECDSA.recover(digest, signature) != signer) revert InvalidSignature();

    aavePool.flashLoanSimple(
      address(this),
      order.debtAsset,
      order.repayAmount,
      abi.encode(CallbackData({order: order, executor: msg.sender})),
      order.referralCode
    );
  }

  // -----------------------------
  // Callback
  // -----------------------------
  function executeOperation(
    address asset,
    uint256 amount,
    uint256 premium,
    address initiator,
    bytes calldata params
  ) external override nonReentrant returns (bool) {
    if (msg.sender != address(aavePool)) revert BadCaller();
    if (initiator != address(this)) revert BadInitiator();

    CallbackData memory cb = abi.decode(params, (CallbackData));
    Order memory order = cb.order;

    if (asset != order.debtAsset) revert AssetMismatch();
    if (amount != order.repayAmount) revert AmountMismatch();

    // 1) Approve Aave Pool to spend debt asset
    IERC20(asset).forceApprove(address(aavePool), amount);

    // 2) LiquidateCall
    // Note: We receive underlying collateral (receiveAToken = false)
    uint256 collBefore = IERC20(order.collateralAsset).balanceOf(address(this));
    
    aavePool.liquidationCall(
        order.collateralAsset,
        order.debtAsset,
        order.borrower,
        amount,
        false // get underlying
    );

    uint256 collAfter = IERC20(order.collateralAsset).balanceOf(address(this));
    uint256 collReceived = collAfter - collBefore;
    
    if (collReceived == 0) revert NoCollateral();

    // 3) Swap Collateral -> Debt Asset
    IERC20(order.collateralAsset).forceApprove(address(swapRouter), collReceived);

    ISwapRouter02.ExactInputParams memory p = ISwapRouter02.ExactInputParams({
      path: order.uniPath,
      recipient: address(this),
      deadline: block.timestamp,
      amountIn: collReceived,
      amountOutMinimum: order.amountOutMin
    });

    uint256 loanOut = swapRouter.exactInput(p);

    // 4) Repay Flashloan
    uint256 totalDebt = amount + premium;
    if (loanOut < totalDebt + order.minProfit) revert ProfitTooLow();

    IERC20(asset).forceApprove(address(aavePool), totalDebt);

    // 5) Profit
    uint256 profit = IERC20(asset).balanceOf(address(this)) - totalDebt;
    if (profit > 0) IERC20(asset).safeTransfer(treasury, profit);

    // Dust
    uint256 dust = IERC20(order.collateralAsset).balanceOf(address(this));
    if (dust > 0) IERC20(order.collateralAsset).safeTransfer(treasury, dust);

    emit Executed(cb.executor, order.borrower, asset, order.collateralAsset, amount, premium, collReceived, loanOut, profit);

    return true;
  }

  // -----------------------------
  // Helpers
  // -----------------------------
  function rescue(address token, uint256 amt, address to) external onlyOwner {
    if (to == address(0)) revert ZeroAddress();
    IERC20(token).safeTransfer(to, amt);
  }

  function _precheck(Order calldata order) internal view {
    if (order.deadline < block.timestamp) revert DeadlineExpired();
    if (order.maxTxGasPrice != 0 && tx.gasprice > order.maxTxGasPrice) revert GasPriceTooHigh();
    if (order.debtAsset == address(0) || order.collateralAsset == address(0)) revert ZeroAddress();
    if (order.borrower == address(0)) revert ZeroAddress();
    if (treasury == address(0)) revert ZeroAddress();
    if (order.repayAmount == 0) revert AmountMismatch();
  }

  function _hashOrder(Order calldata o) internal pure returns (bytes32) {
    return keccak256(
      abi.encode(
        ORDER_TYPEHASH,
        o.debtAsset,
        o.collateralAsset,
        o.borrower,
        o.repayAmount,
        keccak256(o.uniPath),
        o.amountOutMin,
        o.minProfit,
        o.deadline,
        o.maxTxGasPrice,
        o.referralCode,
        o.nonce
      )
    );
  }
}
