// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.10;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./IPoolBase.sol";

interface IPool is IPoolBase {
    function dai() external view returns(IERC20);
}