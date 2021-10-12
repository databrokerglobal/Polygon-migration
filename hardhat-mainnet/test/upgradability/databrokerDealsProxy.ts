import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { Signer } from "ethers";
import hre from "hardhat";
import { DatabrokerDeals } from "../../typechain/DatabrokerDeals";
import { DTX } from "../../typechain/DTX";
import { USDT } from "../../typechain/USDT";

const { waffle } = hre;
const { deployMockContract } = waffle;
const IUniswap = require("../../artifacts/@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol/IUniswapV2Router02.json");

describe("DatabrokerDeals.sol", () => {
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

  it("databroker deals upgradability", async () => {
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

    const deal1 = await deals.getDealByIndex(0);
    expect(deal1["did"]).to.be.equal("did:databroker:deal1:weatherdata");

    // Upgrade the createDeal function and upgrade the DatabrokerDeals contract
    const DatabrokerDealsV2 = await ethers.getContractFactory(
      "DatabrokerDealsV2"
    );
    const upgradedDeals = await upgrades.upgradeProxy(
      deals.address,
      DatabrokerDealsV2
    );

    // Create a new deal
    await usdt.transfer(upgradedDeals.address, ethers.utils.parseUnits("1000"));
    await mockUniswap.mock.swapExactTokensForTokens.returns([
      ethers.utils.parseUnits("1000"),
      ethers.utils.parseUnits("20000"),
    ]);
    await upgradedDeals.burnUSDT(ethers.utils.parseUnits("1000"));
    await dtx.transfer(upgradedDeals.address, ethers.utils.parseUnits("20000"));
    await upgradedDeals.createDealV2(
      "did:databroker:deal2:geography",
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

    const deal2 = await upgradedDeals.getDealByIndex(101);
    expect(deal2["did"]).to.be.equal("did:databroker:deal2:geography");
  });
});
