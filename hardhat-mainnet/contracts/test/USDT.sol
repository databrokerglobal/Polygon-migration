pragma solidity ^0.8.6;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract USDT is ERC20 {
  constructor(uint256 initialSupply) ERC20("DTX", "DTX") {
    _mint(msg.sender, initialSupply);
    _mint(address(this), initialSupply);
  }
}
