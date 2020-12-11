// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.10;

import "./ICToken.sol";
import "./IPoolBase.sol";

interface ICPool is IPoolBase {
    function cDai() external view returns(ICToken);
}