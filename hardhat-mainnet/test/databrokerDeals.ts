import { expect } from "chai";
import { ethers } from "hardhat";
import { Signer } from "ethers";
import hre from "hardhat";
import { DatabrokerDeals } from "../typechain/DatabrokerDeals";
import { DTX } from "../typechain/DTX";
import { USDT } from "../typechain/USDT";

const { waffle } = hre;
const { deployMockContract } = waffle;
const IUniswap = require("../artifacts/@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol/IUniswapV2Router02.json");

describe("Upgradability test", () => {
  let deals: DatabrokerDeals;
  let usdt: USDT;
  let dtx: DTX;
  let mockUniswap: any;
  let owner: Signer;
  let admin: Signer;
  let buyer: Signer;
  let seller: Signer;
  let temp: Signer;
  let buyer1: Signer;
  const dtxStakingAddress = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";
  const payoutWalletAddress = "0xa2Bd44b574035B347C48e426C50Bae6e6e392b3e";
  const platformAddress = "0x30e2069949f39993DdF20767e1f484F01FA5bF59";
  const uniswapDeadline = 1200;

  beforeEach(async () => {
    [owner, admin, buyer, seller, buyer1, temp] = await ethers.getSigners();

    mockUniswap = await deployMockContract(owner, IUniswap.abi);

    const usdtFactory = await ethers.getContractFactory("USDT", owner);
    usdt = await usdtFactory.deploy(ethers.utils.parseUnits("999999"));
    await usdt.deployed();

    const dtxFactory = await ethers.getContractFactory("DTX", owner);
    dtx = await dtxFactory.deploy(ethers.utils.parseUnits("999999"));
    await dtx.deployed();

    const DatabrokerDeals = await ethers.getContractFactory("DatabrokerDeals");

    deals = (await upgrades.deployProxy(
      DatabrokerDeals,
      [
        usdt.address,
        dtx.address,
        mockUniswap.address,
        payoutWalletAddress,
        dtxStakingAddress,
        await admin.getAddress(),
        uniswapDeadline,
        50,
      ],
      {
        initializer: "initialize",
        kind: "uups",
      }
    )) as DatabrokerDeals;
  });

  async function createNewDeal() {
    // Buyer pays the deal price in fiat
    // Transak will convert fiat currency to USDT and deposit on DatabrokerDeals.sol address

    // Mock the transfer deal amount of 1000 USDT to DatabrokerDeals.sol
    await usdt.transfer(deals.address, ethers.utils.parseUnits("1000"));

    // mock uniswap functions for `createDeal` and add swapped DTX fund
    await mockUniswap.mock.swapExactTokensForTokens.returns([
      ethers.utils.parseUnits("1000"),
      ethers.utils.parseUnits("20000"),
    ]);
    await deals.burnUSDT(ethers.utils.parseUnits("1000"));
    await dtx.transfer(deals.address, ethers.utils.parseUnits("20000"));

    // Create a deal
    await deals.createDeal(
      "did:databroker:deal1:weatherdata",
      await buyer.getAddress(),
      await seller.getAddress(),
      "0xf6a76b4e1400b4386a5a4eee9f4a6144bc982a9b84c70fd04cbf18aa80bcdb3e",
      ethers.utils.parseUnits("1000"),
      ethers.utils.parseUnits("20000"), // Min DTX from swap
      20,
      50,
      1296000, // 15 days
      platformAddress
    );
  }

  it("Happy path", async () => {
    await createNewDeal();

    // Time travel by 15 days
    await hre.network.provider.request({
      method: "evm_increaseTime",
      params: [1296000],
    });

    // mock uniswap functions for `payout` and add swapped seller's commission in USDT
    // Amounts in for seller's commission
    await mockUniswap.mock.getAmountsIn.returns([
      ethers.utils.parseUnits("16000"),
      ethers.utils.parseUnits("800"),
    ]);

    // Amounts out for seller's commission
    await mockUniswap.mock.getAmountsOut.returns([
      ethers.utils.parseUnits("16000"),
      ethers.utils.parseUnits("800"),
    ]);
    await mockUniswap.mock.swapExactTokensForTokens.returns([
      ethers.utils.parseUnits("16000"),
      ethers.utils.parseUnits("800"),
    ]);

    // payout
    await deals.payout(0);

    // Mock the swap transfers in payout function
    await deals.burnDTX(ethers.utils.parseUnits("16000"));
    await usdt.transfer(payoutWalletAddress, ethers.utils.parseUnits("800"));

    // Asserts
    // Seller's commission
    expect((await usdt.balanceOf(payoutWalletAddress)).toString()).to.be.equal(
      ethers.utils.parseUnits("800").toString()
    );
    // Staking commission
    expect((await dtx.balanceOf(dtxStakingAddress)).toString()).to.be.equal(
      ethers.utils.parseUnits("2000").toString() // 2000 DTX = 100 USDT
    );
    // databroker/platform commission
    expect((await dtx.balanceOf(platformAddress)).toString()).to.be.equal(
      ethers.utils.parseUnits("2000").toString() // 2000 DTX = 100 USDT
    );
  });

  it("Buyer declines the deal within the lock period", async () => {
    await createNewDeal();

    // Time travel by 10 days
    await hre.network.provider.request({
      method: "evm_increaseTime",
      params: [864000],
    });

    // Buyer declines the deal after 10
    await deals.declineDeal(0);

    // mock uniswap functions for `settleDeclinedDeal` and swapped buyer's refund amount in USDT
    // Amounts in for buyer's refund
    await mockUniswap.mock.getAmountsIn.returns([
      ethers.utils.parseUnits("20000"),
      ethers.utils.parseUnits("1000"),
    ]);
    await mockUniswap.mock.swapExactTokensForTokens.returns([
      ethers.utils.parseUnits("20000"),
      ethers.utils.parseUnits("1000"),
    ]);

    // Final settelmint after buyer declines after the lock period is over
    // Time travel by 6 days
    await hre.network.provider.request({
      method: "evm_increaseTime",
      params: [86400 * 6],
    });
    await deals.settleDeclinedDeal(0);

    // Mock the swap transfers in settleDeclinedDeal function
    await deals.burnDTX(ethers.utils.parseUnits("20000"));
    await usdt.transfer(payoutWalletAddress, ethers.utils.parseUnits("1000"));

    // Asserts
    // Buyer's refund amount
    expect((await usdt.balanceOf(payoutWalletAddress)).toString()).to.be.equal(
      ethers.utils.parseUnits("1000").toString()
    );
    // Staking commission
    expect((await dtx.balanceOf(dtxStakingAddress)).toString()).to.be.equal(
      ethers.utils.parseUnits("0").toString()
    );
    // databroker/platform commission
    expect((await dtx.balanceOf(platformAddress)).toString()).to.be.equal(
      ethers.utils.parseUnits("0").toString()
    );
  });

  /**
   * Payout calculation Scenario 1 -
   * When DTX per USDT price is lower than when deal was created and
   * When platform commission will be greater than extra DTX to be compensated from platform commission
   */
  it("Payout Scenario 1", async () => {
    await createNewDeal();

    // Time travel by 15 days
    await hre.network.provider.request({
      method: "evm_increaseTime",
      params: [1296000],
    });

    // mock uniswap functions for `payout` and add swapped seller's commission in USDT
    // During payout LP price - 1 USDT ~ 0.045 DTX
    // Amounts in for seller's commission
    await mockUniswap.mock.getAmountsIn.returns([
      ethers.utils.parseUnits("17777"),
      ethers.utils.parseUnits("800"),
    ]);

    // Amounts out for seller's commission
    await mockUniswap.mock.getAmountsOut.returns([
      ethers.utils.parseUnits("17777"),
      ethers.utils.parseUnits("800"),
    ]);
    await mockUniswap.mock.swapExactTokensForTokens.returns([
      ethers.utils.parseUnits("17777"),
      ethers.utils.parseUnits("800"),
    ]);

    // payout
    await deals.payout(0);

    // Mock the swap transfers in payout function
    await deals.burnDTX(ethers.utils.parseUnits("17777"));
    await usdt.transfer(payoutWalletAddress, ethers.utils.parseUnits("800"));

    // Asserts
    // Seller's commission
    expect((await usdt.balanceOf(payoutWalletAddress)).toString()).to.be.equal(
      ethers.utils.parseUnits("800").toString()
    );
    // Extra DTX that was compensated for seller's commission will be removed from databroker/platform commission and Staking commission
    // Staking commission
    expect((await dtx.balanceOf(dtxStakingAddress)).toString()).to.be.equal(
      ethers.utils.parseUnits("1111.5").toString() // 1111.5 DTX = 50.0175 USDT
    );
    // databroker/platform commission
    expect((await dtx.balanceOf(platformAddress)).toString()).to.be.equal(
      ethers.utils.parseUnits("1111.5").toString() // 1111.5 DTX = 50.0175 USDT
    );
  });

  /**
   * Payout calculation Scenario 2 -
   * When DTX per USDT price is lower than when deal was created and
   * When platform commission will be less than or equal to the extra DTX to be compensated from platform commission
   */
  it("Payout Scenario 2", async () => {
    await createNewDeal();

    // Time travel by 15 days
    await hre.network.provider.request({
      method: "evm_increaseTime",
      params: [1296000],
    });

    // mock uniswap functions for `payout` and add swapped seller's commission in USDT
    // During payout LP price - 1 USDT = 0.04 DTX
    // Extra DTX that was compensated for seller's commission will be deducted from the extra maintained DTX on DatabrokerDeals.sol for this purpose.
    // Amounts in for seller's commission
    await mockUniswap.mock.getAmountsIn.returns([
      ethers.utils.parseUnits("20000"),
      ethers.utils.parseUnits("800"),
    ]);

    // Amounts out for seller's commission
    await mockUniswap.mock.getAmountsOut.returns([
      ethers.utils.parseUnits("20000"),
      ethers.utils.parseUnits("800"),
    ]);
    await mockUniswap.mock.swapExactTokensForTokens.returns([
      ethers.utils.parseUnits("20000"),
      ethers.utils.parseUnits("800"),
    ]);

    // payout
    await deals.payout(0);

    // Mock the swap transfers in payout function
    await deals.burnDTX(ethers.utils.parseUnits("20000"));
    await usdt.transfer(payoutWalletAddress, ethers.utils.parseUnits("800"));

    // Asserts
    // Seller's commission
    expect((await usdt.balanceOf(payoutWalletAddress)).toString()).to.be.equal(
      ethers.utils.parseUnits("800").toString()
    );
    // Staking commission
    expect((await dtx.balanceOf(dtxStakingAddress)).toString()).to.be.equal(
      ethers.utils.parseUnits("0").toString()
    );
    // databroker/platform commission
    expect((await dtx.balanceOf(platformAddress)).toString()).to.be.equal(
      ethers.utils.parseUnits("0").toString()
    );
  });

  /**
   * Payout calculation Scenario 3 -
   * When DTX per USDT price is greater than when the deal was created
   */
  it("Payout Scenario 3", async () => {
    await createNewDeal();

    // Time travel by 15 days
    await hre.network.provider.request({
      method: "evm_increaseTime",
      params: [1296000],
    });

    // mock uniswap functions for `payout` and add swapped seller's commission in USDT
    // During payout LP price - 1 USDT ~ 0.055 DTX
    // Amounts in for seller's commission
    await mockUniswap.mock.getAmountsIn.returns([
      ethers.utils.parseUnits("14545"),
      ethers.utils.parseUnits("800"),
    ]);

    // Amounts out for seller's commission
    await mockUniswap.mock.getAmountsOut.returns([
      ethers.utils.parseUnits("14545"),
      ethers.utils.parseUnits("800"),
    ]);
    await mockUniswap.mock.swapExactTokensForTokens.returns([
      ethers.utils.parseUnits("14545"),
      ethers.utils.parseUnits("800"),
    ]);

    // payout
    await deals.payout(0);

    // Mock the swap transfers in payout function
    await deals.burnDTX(ethers.utils.parseUnits("14545"));
    await usdt.transfer(payoutWalletAddress, ethers.utils.parseUnits("800"));

    // Asserts
    // Seller's commission
    expect((await usdt.balanceOf(payoutWalletAddress)).toString()).to.be.equal(
      ethers.utils.parseUnits("800").toString()
    );
    // Extra DTX will be divided between databroker/platform commission and Staking commission
    // Staking commission
    expect((await dtx.balanceOf(dtxStakingAddress)).toString()).to.be.equal(
      ethers.utils.parseUnits("2727.5").toString() // 2727.5 DTX = 150.0125 USDT
    );
    // databroker/platform commission
    expect((await dtx.balanceOf(platformAddress)).toString()).to.be.equal(
      ethers.utils.parseUnits("2727.5").toString() // 2727.5 DTX = 150.0125 USDT
    );
  });

  it("Should revert if payout has already been processed", async () => {
    await createNewDeal();

    // Time travel by 15 days
    await hre.network.provider.request({
      method: "evm_increaseTime",
      params: [1296000],
    });

    // mock uniswap functions for `payout` and add swapped seller's commission in USDT
    // During payout LP price - 1 USDT ~ 0.055 DTX
    // Amounts in for seller's commission
    await mockUniswap.mock.getAmountsIn.returns([
      ethers.utils.parseUnits("14545"),
      ethers.utils.parseUnits("800"),
    ]);

    // Amounts out for seller's commission
    await mockUniswap.mock.getAmountsOut.returns([
      ethers.utils.parseUnits("14545"),
      ethers.utils.parseUnits("800"),
    ]);
    await mockUniswap.mock.swapExactTokensForTokens.returns([
      ethers.utils.parseUnits("14545"),
      ethers.utils.parseUnits("800"),
    ]);
    await usdt.transfer(payoutWalletAddress, ethers.utils.parseUnits("800"));

    // payout
    await deals.payout(0);

    // Mock the swap transfers in payout function
    await deals.burnDTX(ethers.utils.parseUnits("14545"));
    await usdt.transfer(payoutWalletAddress, ethers.utils.parseUnits("800"));

    // Assert if payout is processed again
    await expect(deals.payout(0)).to.be.revertedWith(
      "DatabrokerDeals: Payout already processed"
    );
  });

  it("Should revert the payout if deal is locked or if buyer declines the payout", async () => {
    await createNewDeal();

    // Assert if payout reverts when deal is still locked
    await expect(deals.payout(0)).to.be.revertedWith(
      "DatabrokerDeals: Deal is locked for payout"
    );

    // buyer declines the payout
    await deals.declineDeal(0);

    // Assert if payout is processed again
    await expect(deals.payout(0)).to.be.revertedWith(
      "DatabrokerDeals: Deal was declined by buyer"
    );
  });

  /**
   * This case might happen when some amount of DTX from DatabrokerDeals contract
   * was compensated for the another deal and DatabrokerDeals contract now doesn't have
   * enough DTX to swap and distribute among seller and platform
   */
  it("Should revert if deals contract has insufficient balance", async () => {
    await createNewDeal();

    // Burn some DTX to replicate the scenario of less DTX balance of contract
    deals.burnDTX(ethers.utils.parseUnits("500"));

    // Time travel by 15 days
    await hre.network.provider.request({
      method: "evm_increaseTime",
      params: [1296000],
    });

    // mock uniswap functions for `payout` and add swapped seller's commission in USDT
    // During payout LP price - 1 USDT ~ 0.015 DTX
    // Amounts in for seller's commission
    await mockUniswap.mock.getAmountsIn.returns([
      ethers.utils.parseUnits("17777"),
      ethers.utils.parseUnits("800"),
    ]);

    // Amounts out for seller's commission
    await mockUniswap.mock.getAmountsOut.returns([
      ethers.utils.parseUnits("17777"),
      ethers.utils.parseUnits("800"),
    ]);
    await mockUniswap.mock.swapExactTokensForTokens.returns([
      ethers.utils.parseUnits("17777"),
      ethers.utils.parseUnits("800"),
    ]);
    await usdt.transfer(payoutWalletAddress, ethers.utils.parseUnits("800"));

    // Assert payout
    await expect(deals.payout(0)).to.be.revertedWith(
      "DatabrokerDeals: Insufficient DTX balance of contract"
    );
  });

  /**
   * should not be able to decline a deal is time period for it is over and
   * should not be able to decline already declined deal
   */
  it("should assert decline deal reverts", async () => {
    await createNewDeal();

    await deals.declineDeal(0);

    // Should revert if deal is declined again
    await expect(deals.declineDeal(0)).to.be.revertedWith(
      "DatabrokerDeals: Deal was already declined"
    );

    await deals.acceptDeal(0);

    const deal = await deals.getDealByIndex(0);
    expect(deal[12]).to.be.equal(true);

    // should revert if time period for rejecting the deal is over
    // Time travel by 15 days
    await hre.network.provider.request({
      method: "evm_increaseTime",
      params: [1296000],
    });

    await expect(deals.declineDeal(0)).to.be.revertedWith(
      "DatabrokerDeals: Time duration for declining the deal is over"
    );
  });

  /**
   * should not be able to accept a deal is time period for it is over and
   * should not be able to accept already accepted deal
   */
  it("should assert accept deal reverts", async () => {
    await createNewDeal();

    // Should revert if deal is declined again
    await expect(deals.acceptDeal(0)).to.be.revertedWith(
      "DatabrokerDeals: Deal was already accepted"
    );

    await deals.declineDeal(0);

    const deal = await deals.getDealByIndex(0);
    expect(deal[12]).to.be.equal(false);

    // should revert if time period for accepting the deal is over
    // Time travel by 15 days
    await hre.network.provider.request({
      method: "evm_increaseTime",
      params: [1296000],
    });

    await expect(deals.acceptDeal(0)).to.be.revertedWith(
      "DatabrokerDeals: Time duration for accepting the deal is over"
    );
  });

  it("should settle declined payout", async () => {
    await createNewDeal();

    await deals.declineDeal(0);

    // mock uniswap functions for `settleDeclinedDeal` and add swapped buyer's refund in USDT
    // Amounts in for buyer's refund
    await mockUniswap.mock.getAmountsIn.returns([
      ethers.utils.parseUnits("20000"),
      ethers.utils.parseUnits("1000"),
    ]);

    // Mock the dtx to usdt swap
    await mockUniswap.mock.swapExactTokensForTokens.returns([
      ethers.utils.parseUnits("1000"),
      ethers.utils.parseUnits("20000"),
    ]);

    // Time travel by 15 days
    await hre.network.provider.request({
      method: "evm_increaseTime",
      params: [1296000],
    });

    await deals.settleDeclinedDeal(0);

    // Mock the swap transfers in payout function
    await deals.burnDTX(ethers.utils.parseUnits("20000"));
    await usdt.transfer(payoutWalletAddress, ethers.utils.parseUnits("1000"));

    expect((await usdt.balanceOf(payoutWalletAddress)).toString()).to.be.equal(
      ethers.utils.parseUnits("1000")
    );
  });

  it("should assert settleDeclinedDeal reverts", async () => {
    await createNewDeal();

    await expect(deals.settleDeclinedDeal(0)).to.be.revertedWith(
      "DatabrokerDeals: Deal is not declined by buyer"
    );

    await deals.declineDeal(0);

    await expect(deals.settleDeclinedDeal(0)).to.be.revertedWith(
      "DatabrokerDeals: Deal is locked for payout"
    );

    await deals.acceptDeal(0);

    // Time travel by 15 days
    await hre.network.provider.request({
      method: "evm_increaseTime",
      params: [1296000],
    });

    // mock uniswap functions for `payout` and add swapped seller's commission in USDT
    // Amounts in for seller's commission
    await mockUniswap.mock.getAmountsIn.returns([
      ethers.utils.parseUnits("16000"),
      ethers.utils.parseUnits("800"),
    ]);

    // Amounts out for seller's commission
    await mockUniswap.mock.getAmountsOut.returns([
      ethers.utils.parseUnits("16000"),
      ethers.utils.parseUnits("800"),
    ]);
    await mockUniswap.mock.swapExactTokensForTokens.returns([
      ethers.utils.parseUnits("16000"),
      ethers.utils.parseUnits("800"),
    ]);

    // payout
    await deals.payout(0);

    // Mock the swap transfers in payout function
    await deals.burnDTX(ethers.utils.parseUnits("16000"));
    await usdt.transfer(payoutWalletAddress, ethers.utils.parseUnits("800"));

    await expect(deals.settleDeclinedDeal(0)).to.be.revertedWith(
      "DatabrokerDeals: Payout already processed"
    );
  });

  it("should revert if DTX balance is low when settleDeclinedDeal is called", async () => {
    await createNewDeal();

    await deals.declineDeal(0);

    // mock uniswap functions for `settleDeclinedDeal` and add swapp buyer's refund in USDT
    // Amounts in for buyer's refund
    await mockUniswap.mock.getAmountsIn.returns([
      ethers.utils.parseUnits("20000"),
      ethers.utils.parseUnits("1000"),
    ]);

    // Mock the dtx to usdt swap
    await mockUniswap.mock.swapExactTokensForTokens.returns([
      ethers.utils.parseUnits("1000"),
      ethers.utils.parseUnits("20000"),
    ]);

    // remove some DTX tokens from deals contract to mock the scenario of less DTX balance available
    await deals.burnDTX(ethers.utils.parseUnits("1000"));

    // Time travel by 15 days
    await hre.network.provider.request({
      method: "evm_increaseTime",
      params: [1296000],
    });

    await expect(deals.settleDeclinedDeal(0)).to.be.revertedWith(
      "DatabrokerDeals: Insufficient DTX balance of contract"
    );
  });

  it("asserts view only functions", async () => {
    await createNewDeal();

    const deal = await deals.getDealByIndex(0);
    const did = await deal["did"];

    expect(did).to.be.equal("did:databroker:deal1:weatherdata");
    expect((await deals.getDealIndexesForDid(did)).toString()).to.be.equal("0");

    // create one more deal
    await deals.createDeal(
      "did:databroker:deal2:geography",
      await buyer1.getAddress(),
      await seller.getAddress(),
      "0xf6a76b4e1400b4386a5a4eee9f4a6144bc982a9b84c70fd04cbf18aa80bcdb3e",
      ethers.utils.parseUnits("1000"),
      ethers.utils.parseUnits("20000"), // Min DTX from swap
      20,
      50,
      1296000, // 15 days
      platformAddress
    );

    expect(
      (await deals.getDealIndexesForUser(await buyer.getAddress())).toString()
    ).to.be.equal("0");
    expect(
      (await deals.getDealIndexesForUser(await buyer1.getAddress())).toString()
    ).to.be.equal("1");
    expect(
      (await deals.getDealIndexesForUser(await seller.getAddress())).toString()
    ).to.be.equal("0,1");
  });

  it("should be able to update the required storage variables", async () => {
    await deals.updateDtxInstance("0x9e4e33eF13F67be8Fcfd94c61F0164123de2dF6F");
    await deals.updateUsdtInstance(
      "0x9e4e33eF13F67be8Fcfd94c61F0164123de2dF6F"
    );
    await deals.updateUniswapDeadline("1500");
    await deals.updateSlippagePercentage("30");

    expect((await deals.getUniswapDeadline()).toString()).to.be.equal("1500");
    expect((await deals.getSlippagePercentage()).toString()).to.be.equal("30");
  });

  it("should withdrawAllUsdt and withdrawAllDtx from contract only when there are no active deals", async () => {
    await createNewDeal();

    // Time travel by 15 days
    await hre.network.provider.request({
      method: "evm_increaseTime",
      params: [1296000],
    });

    // Assert if withdrawAllUsdt when there are active deals
    await expect(deals.withdrawAllUsdt()).to.be.revertedWith(
      "DatabrokerDeals: Payout is still pending for some deals"
    );

    // Assert if withdrawAllDtx when there are active deals
    await expect(deals.withdrawAllDtx()).to.be.revertedWith(
      "DatabrokerDeals: Payout is still pending for some deals"
    );

    // mock uniswap functions for `payout` and add swapped seller's commission in USDT
    // Amounts in for seller's commission
    await mockUniswap.mock.getAmountsIn.returns([
      ethers.utils.parseUnits("16000"),
      ethers.utils.parseUnits("800"),
    ]);

    // Amounts out for seller's commission
    await mockUniswap.mock.getAmountsOut.returns([
      ethers.utils.parseUnits("16000"),
      ethers.utils.parseUnits("800"),
    ]);
    await mockUniswap.mock.swapExactTokensForTokens.returns([
      ethers.utils.parseUnits("16000"),
      ethers.utils.parseUnits("800"),
    ]);

    // payout
    await deals.payout(0);

    // Mock the swap transfers in payout function
    await deals.burnDTX(ethers.utils.parseUnits("16000"));
    await usdt.transfer(payoutWalletAddress, ethers.utils.parseUnits("800"));

    // add some extra DTX and USDT
    await usdt.transfer(deals.address, ethers.utils.parseUnits("1000"));
    await dtx.transfer(deals.address, ethers.utils.parseUnits("1000"));

    const ownerUsdtBalance = (
      await usdt.balanceOf(await owner.getAddress())
    ).toString();
    const ownerDtxBalance = (
      await dtx.balanceOf(await owner.getAddress())
    ).toString();

    await deals.withdrawAllUsdt();
    await deals.withdrawAllDtx();

    const ownerNewUsdtBalance = (
      await usdt.balanceOf(await owner.getAddress())
    ).toString();
    const ownerNewDtxBalance = (
      await dtx.balanceOf(await owner.getAddress())
    ).toString();

    expect(ownerUsdtBalance).to.be.equal("997199000000000000000000");
    expect(ownerDtxBalance).to.be.equal("978999000000000000000000");
    expect(ownerNewUsdtBalance).to.be.equal("998199000000000000000000");
    expect(ownerNewDtxBalance).to.be.equal("979999000000000000000000");
  });

  it("should able to get the right deal Index", async () => {
    await createNewDeal();
    const dealIndex = await deals.getLatestDealIndex();

    expect(dealIndex.toString()).to.be.equal("0");
  });

  it("Pausable tests", async () => {
    await deals.pauseContract();
    await expect(createNewDeal()).to.be.revertedWith("Pausable: paused");

    await deals.unPauseContract();
    await createNewDeal();

    await deals.pauseContract();

    await expect(deals.payout(0)).to.be.revertedWith("Pausable: paused");
    await expect(deals.declineDeal(0)).to.be.revertedWith("Pausable: paused");
    await expect(deals.acceptDeal(0)).to.be.revertedWith("Pausable: paused");
    await expect(deals.settleDeclinedDeal(0)).to.be.revertedWith(
      "Pausable: paused"
    );
  });

  it("only admin should be able to pause and unpause the contract functions", async () => {
    await expect(deals.connect(temp).pauseContract()).to.be.revertedWith(
      "Caller is not an admin"
    );

    await deals.pauseContract();

    await expect(deals.connect(temp).unPauseContract()).to.be.revertedWith(
      "Caller is not an admin"
    );
  });

  it("assert isDealIndexValid revert", async () => {
    await createNewDeal();

    await expect(
      deals.calculateTransferAmount(100, [dtx.address, usdt.address])
    ).to.be.revertedWith("DatabrokerDeals: Invalid deal index");
  });

  it("should assert functions with hasOwnerRole", async () => {
    await createNewDeal();

    await expect(deals.connect(temp).withdrawAllUsdt()).to.be.revertedWith(
      "Caller is not an owner"
    );

    await expect(deals.connect(temp).withdrawAllDtx()).to.be.revertedWith(
      "Caller is not an owner"
    );
  });

  it("should assert functions with hasAdminRole", async () => {
    await expect(
      deals.connect(temp).createDeal(
        "did:databroker:deal1:weatherdata",
        await buyer.getAddress(),
        await seller.getAddress(),
        "0xf6a76b4e1400b4386a5a4eee9f4a6144bc982a9b84c70fd04cbf18aa80bcdb3e",
        ethers.utils.parseUnits("1000"),
        ethers.utils.parseUnits("20000"), // Min DTX from swap
        20,
        50,
        1296000, // 15 days
        platformAddress
      )
    ).to.be.revertedWith("Caller is not an admin");

    await expect(deals.connect(temp).payout(0)).to.be.revertedWith(
      "Caller is not an admin"
    );

    await expect(deals.connect(temp).declineDeal(0)).to.be.revertedWith(
      "Caller is not an admin"
    );

    await expect(deals.connect(temp).acceptDeal(0)).to.be.revertedWith(
      "Caller is not an admin"
    );

    await expect(deals.connect(temp).settleDeclinedDeal(0)).to.be.revertedWith(
      "Caller is not an admin"
    );

    await expect(
      deals
        .connect(temp)
        .updateDtxInstance("0x9e4e33eF13F67be8Fcfd94c61F0164123de2dF6F")
    ).to.be.revertedWith("Caller is not an admin");

    await expect(
      deals
        .connect(temp)
        .updateUsdtInstance("0x9e4e33eF13F67be8Fcfd94c61F0164123de2dF6F")
    ).to.be.revertedWith("Caller is not an admin");

    await expect(
      deals.connect(temp).updateUniswapDeadline(100)
    ).to.be.revertedWith("Caller is not an admin");

    await expect(
      deals.connect(temp).updateSlippagePercentage(30)
    ).to.be.revertedWith("Caller is not an admin");
  });
});
