// SPDX-License-Identifier: MIT
/**
 * Copyright (C) SettleMint NV - All Rights Reserved
 *
 * Use of this file is strictly prohibited without an active license agreement.
 * Distribution of this file, via any medium, is strictly prohibited.
 *
 * For license inquiries, contact hello@settlemint.com
 */

pragma solidity ^0.8.6;

import "@openzeppelin/contracts-upgradeable/utils/structs/EnumerableSetUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/CountersUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract DatabrokerDealsV2 is
  Initializable,
  UUPSUpgradeable,
  AccessControlUpgradeable
{
  using EnumerableSetUpgradeable for EnumerableSetUpgradeable.UintSet;
  using CountersUpgradeable for CountersUpgradeable.Counter;

  struct Deal {
    string did;
    address buyerId;
    address sellerId;
    bytes32 dataUrl;
    uint256 dealIndex;
    uint256 amountInDTX;
    uint256 amountInUSDT;
    uint256 validFrom;
    uint256 validUntil;
    uint256 platformPercentage;
    uint256 stakingPercentage;
    address platformAddress;
    bool accepted;
    bool payoutCompleted;
  }

  IERC20 private _usdtToken;
  IERC20 private _dtxToken;
  IUniswapV2Router02 private _uniswap;
  CountersUpgradeable.Counter public _dealIndex;
  EnumerableSetUpgradeable.UintSet private _pendingDeals;

  uint128 public _uniswapDeadline;
  uint128 public _slippagePercentage;
  address public _dtxStakingAddress;
  address public _payoutWalletAddress;
  bytes32 private ADMIN_ROLE;

  mapping(string => uint256[]) public _didToDealIndexes;
  mapping(address => uint256[]) public _userToDealIndexes;
  mapping(uint256 => Deal) private _dealIndexToDeal;

  modifier hasAdminRole() {
    require(hasRole(ADMIN_ROLE, msg.sender), "OA"); // Only Admin
    _;
  }
  modifier isPendingDealsEmpty() {
    require(
      _pendingDeals.length() == 0,
      "PP" // Payout is still pending for some deals
    );
    _;
  }

  event DealCreated(uint256 dealIndex, string did);
  event Payout(
    uint256 dealIndex,
    uint256 sellerAmount,
    uint256 stakingCommission,
    uint256 platformCommission
  );
  event SettleDeal(uint256 dealIndex, uint256 buyerAmount);

  function initialize(
    address usdtToken,
    address dtxToken,
    address uniswap,
    address payoutWalletAddress,
    address dtxStakingAddress,
    address admin,
    uint128 uniswapDeadline,
    uint128 slippagePercentage
  ) public initializer {
    AccessControlUpgradeable.__AccessControl_init();

    ADMIN_ROLE = keccak256("ADMIN_ROLE");

    _usdtToken = IERC20(usdtToken);
    _dtxToken = IERC20(dtxToken);
    _uniswap = IUniswapV2Router02(uniswap);
    _payoutWalletAddress = payoutWalletAddress;
    _dtxStakingAddress = dtxStakingAddress;
    _uniswapDeadline = uniswapDeadline;
    _slippagePercentage = slippagePercentage;

    _setupRole(ADMIN_ROLE, msg.sender);
    _setupRole(ADMIN_ROLE, admin);
  }

  function _authorizeUpgrade(address) internal override hasAdminRole {}

  function createDealV2(
    string memory did,
    address buyerId,
    address sellerId,
    bytes32 dataUrl,
    uint256 amountInUSDT,
    uint256 amountOutMin,
    uint256 platformPercentage,
    uint256 stakingPercentage,
    uint256 lockPeriod,
    address platformAddress
  ) public hasAdminRole {
    address[] memory USDTToDTXPath = new address[](2);
    USDTToDTXPath[0] = address(_usdtToken);
    USDTToDTXPath[1] = address(_dtxToken);

    uint256 amountInDTX = _swapTokens(
      amountInUSDT,
      amountOutMin,
      USDTToDTXPath,
      address(this),
      block.timestamp + _uniswapDeadline
    );
    uint256 dealIndex = _dealIndex.current() + 100;

    Deal memory newDeal = Deal(
      did,
      buyerId,
      sellerId,
      dataUrl,
      dealIndex,
      amountInDTX,
      amountInUSDT,
      block.timestamp,
      block.timestamp + lockPeriod,
      platformPercentage,
      stakingPercentage,
      platformAddress,
      true,
      false
    );

    _didToDealIndexes[did].push(dealIndex);
    _dealIndexToDeal[dealIndex] = newDeal;
    _pendingDeals.add(dealIndex);

    _userToDealIndexes[sellerId].push(dealIndex);
    if (sellerId != buyerId) {
      _userToDealIndexes[buyerId].push(dealIndex);
    }

    emit DealCreated(dealIndex, did);

    _dealIndex.increment();
  }

  function payout(uint256 dealIndex) public hasAdminRole {
    Deal storage deal = _dealIndexToDeal[dealIndex];

    require(
      !deal.payoutCompleted &&
        deal.accepted &&
        deal.validUntil <= block.timestamp,
      "ID"
    ); // Invalid deal

    address[] memory DTXToUSDTPath = new address[](2);
    DTXToUSDTPath[0] = address(_dtxToken);
    DTXToUSDTPath[1] = address(_usdtToken);

    (
      uint256 sellerAmountInDTX,
      uint256 databrokerCommission,
      uint256 stakingCommission
    ) = calculateTransferAmount(
        dealIndex,
        deal.amountInDTX,
        deal.amountInUSDT,
        deal.platformPercentage,
        deal.stakingPercentage,
        DTXToUSDTPath
      );

    require(
      _dtxToken.balanceOf(address(this)) >=
        (sellerAmountInDTX + databrokerCommission + stakingCommission),
      "IDTX" // Insufficient DTX balance of contract
    );

    uint256[] memory sellerAmounts = _uniswap.getAmountsOut(
      sellerAmountInDTX,
      DTXToUSDTPath
    );
    uint256 sellerAmountOutMin = sellerAmounts[1] -
      ((sellerAmounts[1] * _slippagePercentage) / 10000);

    _pendingDeals.remove(dealIndex);
    deal.payoutCompleted = true;

    // Seller's USDT to payout wallet address
    _swapTokens(
      sellerAmountInDTX,
      sellerAmountOutMin,
      DTXToUSDTPath,
      _payoutWalletAddress,
      block.timestamp + _uniswapDeadline
    );

    require(
      _dtxToken.transfer(_dtxStakingAddress, stakingCommission) &&
        _dtxToken.transfer(deal.platformAddress, databrokerCommission),
      "TF" // DTX transfer failed
    );

    emit Payout(
      dealIndex,
      sellerAmounts[1],
      stakingCommission,
      databrokerCommission
    );
  }

  function calculateTransferAmount(
    uint256 dealIndex,
    uint256 amountInDTX,
    uint256 amountInUSDT,
    uint256 platformPercentage,
    uint256 stakingPercentage,
    address[] memory DTXToUSDTPath
  )
    public
    view
    returns (
      uint256,
      uint256,
      uint256
    )
  {
    require(dealIndex <= _dealIndex.current(), "II"); // Invalid Index

    uint256 platformShareInDTX = (amountInDTX * (platformPercentage)) / (100);
    uint256 sellerShareInDTX = amountInDTX - platformShareInDTX;

    uint256 platformShareInUSDT = (amountInUSDT * (platformPercentage)) / (100);
    uint256 sellerShareInUSDT = amountInUSDT - platformShareInUSDT;

    uint256[] memory sellerSwapAmounts = _uniswap.getAmountsIn(
      sellerShareInUSDT,
      DTXToUSDTPath
    );

    // Adjust the DTX tokens that needs to be converted for seller, also adjust the platform commission accordingly
    uint256 sellerTransferAmountInDTX;
    uint256 platformCommission = 0;
    if (sellerSwapAmounts[0] > sellerShareInDTX) {
      uint256 extraDTXToBeAdded = sellerSwapAmounts[0] - (sellerShareInDTX);
      sellerTransferAmountInDTX = sellerShareInDTX + (extraDTXToBeAdded);

      if (platformShareInDTX > extraDTXToBeAdded) {
        platformCommission = platformShareInDTX - (extraDTXToBeAdded);
      } else {
        platformCommission = 0;
      }
    } else {
      uint256 extraDTXToBeRemoved = sellerShareInDTX - (sellerSwapAmounts[0]);
      sellerTransferAmountInDTX = sellerShareInDTX - extraDTXToBeRemoved;
      platformCommission = platformShareInDTX + extraDTXToBeRemoved;
    }

    uint256 stakingCommission = (platformCommission * stakingPercentage) / 100;
    uint256 databrokerCommission = platformCommission - stakingCommission;

    return (sellerTransferAmountInDTX, databrokerCommission, stakingCommission);
  }

  function declineDeal(uint256 dealIndex) public hasAdminRole {
    Deal storage deal = _dealIndexToDeal[dealIndex];

    require(deal.accepted && deal.validUntil > block.timestamp, "ID");

    deal.accepted = false;
  }

  function acceptDeal(uint256 dealIndex) public hasAdminRole {
    Deal storage deal = _dealIndexToDeal[dealIndex];

    require(!deal.accepted && deal.validUntil > block.timestamp, "ID");

    deal.accepted = true;
  }

  function settleDeclinedDeal(uint256 dealIndex) public hasAdminRole {
    Deal storage deal = _dealIndexToDeal[dealIndex];

    require(
      !deal.payoutCompleted &&
        !deal.accepted &&
        deal.validUntil <= block.timestamp,
      "ID" // Invalid deal
    );

    address[] memory DTXToUSDTPath = new address[](2);
    DTXToUSDTPath[0] = address(_dtxToken);
    DTXToUSDTPath[1] = address(_usdtToken);

    uint256[] memory amountsIn = _uniswap.getAmountsIn(
      deal.amountInUSDT,
      DTXToUSDTPath
    );
    uint256 buyerAmountOutMin = amountsIn[1] -
      (amountsIn[1] * _slippagePercentage) /
      10000;

    require(
      _dtxToken.balanceOf(address(this)) >= amountsIn[0],
      "IDTX" // Insufficient DTX balance of contract
    );

    deal.payoutCompleted = true;
    _pendingDeals.remove(dealIndex);

    // Buyer's USDT to payout wallet address
    _swapTokens(
      amountsIn[0],
      buyerAmountOutMin,
      DTXToUSDTPath,
      _payoutWalletAddress,
      block.timestamp + _uniswapDeadline
    );

    emit SettleDeal(dealIndex, amountsIn[1]);
  }

  function _swapTokens(
    uint256 amountIn,
    uint256 amountOutMin,
    address[] memory path,
    address receiverAddress,
    uint256 deadline
  ) internal returns (uint256) {
    // Give approval for the uniswap to swap the USDT token from this contract address
    IERC20(path[0]).approve(address(_uniswap), amountIn);

    uint256[] memory amounts = _uniswap.swapExactTokensForTokens(
      amountIn,
      amountOutMin,
      path,
      receiverAddress,
      deadline
    );

    return amounts[1];
  }

  function getDealByIndex(uint256 dealIndex)
    public
    view
    returns (Deal memory deal)
  {
    deal = _dealIndexToDeal[dealIndex];
  }

  function getDealIndexesForDid(string memory did)
    public
    view
    returns (uint256[] memory dealIndexesForDid)
  {
    dealIndexesForDid = _didToDealIndexes[did];
  }

  function getDealIndexesForUser(address user)
    public
    view
    returns (uint256[] memory dealIndexesForUser)
  {
    dealIndexesForUser = _userToDealIndexes[user];
  }

  function updateDtxInstance(address newDTXAddress) public hasAdminRole {
    _dtxToken = IERC20(newDTXAddress);
  }

  function updateUsdtInstance(address newUSDTAddress) public hasAdminRole {
    _usdtToken = IERC20(newUSDTAddress);
  }

  function updateUniswapDetails(uint128 deadline, uint128 slippagePercentage)
    public
    hasAdminRole
  {
    _uniswapDeadline = deadline;
    _slippagePercentage = slippagePercentage;
  }

  function withdrawAllTokens() public hasAdminRole isPendingDealsEmpty {
    _usdtToken.transfer(msg.sender, _usdtToken.balanceOf(address(this)));
    require(
      _dtxToken.transfer(msg.sender, _dtxToken.balanceOf(address(this))),
      "DTF" // DTX transfer failed
    );
  }

  // Unit test functions
  // Uncomment to run the tests
  // function burnUSDT(uint256 amount) public {
  //   _usdtToken.transfer(0x71CB05EE1b1F506fF321Da3dac38f25c0c9ce6E1, amount);
  // }

  // function burnDTX(uint256 amount) public {
  //   _dtxToken.transfer(0x71CB05EE1b1F506fF321Da3dac38f25c0c9ce6E1, amount);
  // }
}
