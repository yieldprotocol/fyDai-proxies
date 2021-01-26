// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.10;

import "./interfaces/IController.sol";
import "./interfaces/IFYDai.sol";
import "./interfaces/IPool.sol";
import "./interfaces/IProxyRegistry.sol";
import "./helpers/SafeCast.sol";
import "./helpers/YieldAuth.sol";


contract RollProxy {
    using SafeCast for uint256;
    using YieldAuth for IController;

    IERC20 public immutable dai;
    IController public immutable controller;
    IProxyRegistry public immutable proxyRegistry;

    bytes32 public constant WETH = "ETH-A";

    mapping(address => bool) public knownPools;

    constructor(IController controller_, IPool[] memory pools_, IProxyRegistry proxyRegistry_)
        public
    {
        ITreasury _treasury = controller_.treasury();
        IERC20 _dai = dai = _treasury.dai();
        controller = controller_;
        proxyRegistry = proxyRegistry_;

        // Register pool and allow it to take dai and fyDai for trading
        for (uint i = 0 ; i < pools_.length; i++) {
            pools_[i].fyDai().approve(address(pools_[i]), type(uint256).max);
            _dai.approve(address(pools_[i]), type(uint256).max);
            knownPools[address(pools_[i])] = true;
        }

        // Allow treasury to take dai for repaying
        _dai.approve(address(_treasury), type(uint256).max);
    }

    /// @dev Roll debt from one maturity to another
    function rollDebt(
        bytes32 collateral,
        IPool pool1,
        IPool pool2,
        address user,
        uint256 daiDebtToRepay,
        uint256 minDebtRepaid,
        uint256 maxFYDaiCost
    ) public {
        require(
            user == msg.sender || proxyRegistry.proxies(user) == msg.sender,
            "RollProxy: Restricted to user or its dsproxy"
        ); // Redundant, I think
        require(
            knownPools[address(pool1)] && knownPools[address(pool2)],
            "RollProxy: Only known pools"
        ); // Redundant, I think

        bytes memory data = abi.encode(collateral, pool1, pool2, user, daiDebtToRepay, minDebtRepaid);
        // uint256 maxFYDaiCost = pool2.buyDaiPreview(daiDebtToRepay.toUint128()); // TODO: Done off-chain, as slippage protection
        pool2.fyDai().flashMint(maxFYDaiCost, data); // Callback from fyDai will come back to this contract
    }

    /// @dev Flash loan callback, contains most of the logic
    function executeOnFlashMint(
        uint256 maxFYDaiCost,
        bytes memory data
    )
        public
    {
        (bytes32 collateral, IPool pool1, IPool pool2, address user, uint256 daiDebtToRepay, uint256 minDebtRepaid)
            = abi.decode(data, (bytes32, IPool, IPool, address, uint256, uint256));
        require(
            knownPools[address(pool1)] && knownPools[address(pool2)],
            "RollProxy: Only known pools"
        ); // The pools are pools we know.
        require(
            msg.sender == address(pool2.fyDai()),
            "RollProxy: Restricted to known lenders"
        ); // The msg.sender is the fyDai from one of the pools we know, and that we know only calls `executeOnFlashMint` in a strict loop. Therefore we can trust `data`.

        pool2.buyDai(address(this), address(this), daiDebtToRepay.toUint128()); // If the loan (maxFYDaiCost) is not enough for this, is because of slippage. Built-in protection.
        _sellAndRepay(collateral, pool1, user, daiDebtToRepay, minDebtRepaid);
        uint256 fyDaiBalance = pool2.fyDai().balanceOf(address(this));
        controller.borrow(
            collateral,
            pool2.fyDai().maturity(),
            user,
            address(this),
            maxFYDaiCost > fyDaiBalance ? maxFYDaiCost - fyDaiBalance : 0 // TODO: Can this be abused?
        );

        // emit Event(); ?
    }

    /// @dev Repay debt in Dai or in FYDai, depending on whether the fyDai has matured
    function _sellAndRepay(bytes32 collateral, IPool pool, address user, uint256 amount, uint256 minDebtRepaid) private {
        uint256 maturity = pool.fyDai().maturity();

        if (block.timestamp >= maturity){
            controller.repayDai(
                collateral,
                maturity,
                address(this),
                user,
                amount
            );
        } else {
            uint256 fyDaiDebtToRepay = pool.sellDai(address(this), address(this), amount.toUint128());
            require(
                controller.inDai(collateral, maturity, fyDaiDebtToRepay) >= minDebtRepaid,
                "RollProxy: Not enough debt repaid"
            );
            controller.repayFYDai(
                collateral,
                maturity,
                address(this),
                user,
                fyDaiDebtToRepay
            );
        }
    }
}
