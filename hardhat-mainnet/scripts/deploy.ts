const { ethers, upgrades } = require("hardhat");

async function main() {
  const DatabrokerDeals = await ethers.getContractFactory("DatabrokerDeals");
  const databrokerDeals = await upgrades.deployProxy(
    DatabrokerDeals,
    [
      process.env.USDT_ADDRESS,
      process.env.DTX_ADDRESS,
      process.env.UNISWAP_ROUTER_ADDRESS,
      process.env.PAYOUT_WALLET_ADDRESS,
      process.env.DTX_STAKING_ADDRESS,
      process.env.ADMIN_ADDRESS,
      process.env.UNISWAP_DEADLINE,
      process.env.UNISWAP_SLIPPAGE_PERCENTAGE,
    ],
    {
      initializer: "initialize",
      kind: "uups",
    }
  );
  return databrokerDeals.deployed();
}

main()
  .then((databrokerDeals) => {
    console.log("DatabrokerDeals deployed to:", databrokerDeals.address);
  })
  .catch((err) => {
    console.log("Error while deploying the contract", err);
  });
