// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.10;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./interfaces/IController.sol";
import "./interfaces/IWeth.sol";
import "./interfaces/IGemJoin.sol";
import "./interfaces/IDaiJoin.sol";
import "./interfaces/IVat.sol";
import "./interfaces/IPool.sol";
import "./interfaces/IFYDai.sol";


contract ExportProxyBase {

    IVat public vat;
    IWeth public weth;
    IERC20 public dai;
    IGemJoin public wethJoin;
    IDaiJoin public daiJoin;
    IController public controller;

    bytes32 public constant WETH = "ETH-A";

    constructor(IController controller_, IPool[] memory pools_) public {
        controller = controller_;
        ITreasury _treasury = controller.treasury();

        weth = _treasury.weth();
        dai = _treasury.dai();
        daiJoin = _treasury.daiJoin();
        wethJoin = _treasury.wethJoin();
        vat = _treasury.vat();

        // Allow the Treasury to take dai for repaying
        dai.approve(address(_treasury), type(uint256).max);

        // Allow the pools to take dai for trading
        for (uint i = 0 ; i < pools_.length; i++) {
            dai.approve(address(pools_[i]), type(uint256).max);
        }

        // Allow daiJoin to move dai out of vat for this proxy
        vat.hope(address(daiJoin));

        // Allow wethJoin to take weth for collateralization
        weth.approve(address(wethJoin), type(uint256).max);
    }
}
