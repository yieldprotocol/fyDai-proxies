// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.10;

import "./interfaces/IVat.sol";
import "./interfaces/IPool.sol";
import "./helpers/DecimalMath.sol";
import "./helpers/SafeCast.sol";


contract UnitConverter is DecimalMath {
    using SafeCast for uint256;

    IVat public vat;

    bytes32 public constant WETH = "ETH-A";

    constructor(IVat vat_) public {
        vat = vat_;
    }

    /// @dev Convert from MakerDAO debt to Dai
    function debtToDai(uint256 daiAmount) public view returns (uint256) {
        (, uint256 rate,,,) = vat.ilks(WETH);
        return muld(daiAmount, rate);
    }

    /// @dev Convert from Dai to MakerDAO debt
    function daiToDebt(uint256 daiAmount) public view returns (uint256) {
        (, uint256 rate,,,) = vat.ilks(WETH);
        return divd(daiAmount, rate);
    }

    /// @dev Minimum weth needed to collateralize an amount of dai in MakerDAO
    function wethForDai(uint256 daiAmount) public view returns (uint256) {
        (,, uint256 spot,,) = vat.ilks(WETH);
        return divd(daiAmount, spot);
    }

    /// @dev Minimum weth needed to collateralize an amount of fyDai in Yield. Yes, it's the same formula.
    function wethForFYDai(uint256 fyDaiAmount) public view returns (uint256) {
        (,, uint256 spot,,) = vat.ilks(WETH);
        return divd(fyDaiAmount, spot);
    }

    /// @dev Amount of fyDai debt that will result from migrating Dai debt from MakerDAO to Yield
    function fyDaiForDai(IPool pool, uint256 daiAmount) public view returns (uint256) {
        return pool.buyDaiPreview(daiAmount.toUint128());
    }

    /// @dev Amount of dai debt that will result from migrating fyDai debt from Yield to MakerDAO
    function daiForFYDai(IPool pool, uint256 fyDaiAmount) public view returns (uint256) {
        return pool.buyFYDaiPreview(fyDaiAmount.toUint128());
    }
}
