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

    /// @dev Cost in Dai to repay a debt. Given that the debt is denominated in Dai at the time of maturity, this might be lower before then.
    function daiCostToRepay(bytes32 collateral, IPool pool, uint256 daiDebt) public view returns(uint256 daiCost) {
        uint256 maturity = pool.fyDai().maturity();

        if (block.timestamp >= maturity){
            daiCost = daiDebt; // After maturity we pay using Dai, that the debt grows doesn't matter
        } else {
            daiCost = pool.buyFYDaiPreview(
                controller.inFYDai(collateral, maturity, daiDebt).toUint128()
            );
        }        
    }

    /// @dev Roll debt from one maturity to another
    function rollDebt(
        bytes32 collateral,
        IPool pool1,
        IPool pool2,
        address user,
        uint256 daiToBuy,      // Calculate off-chain using daiCostToRepay(collateral, pool1, daiDebtToRepay) or similar
        uint256 maxFYDaiCost   // Calculate off-chain using pool2.buyDaiPreview(daiDebtToRepay.toUint128()), plus accepted slippage
    ) public {
        require(
            user == msg.sender || proxyRegistry.proxies(user) == msg.sender,
            "RollProxy: Restricted to user or its dsproxy"
        ); // Redundant, I think
        require(
            knownPools[address(pool1)] && knownPools[address(pool2)],
            "RollProxy: Only known pools"
        ); // Redundant, I think

        bytes memory data = abi.encode(collateral, pool1, pool2, user, daiToBuy);
        pool2.fyDai().flashMint(maxFYDaiCost, data); // Callback from fyDai will come back to this contract
    }

    /// @dev Flash loan callback, contains most of the logic
    function executeOnFlashMint(
        uint256 maxFYDaiCost,
        bytes memory data
    )
        public
    {
        (bytes32 collateral, IPool pool1, IPool pool2, address user, uint256 daiToBuy)
            = abi.decode(data, (bytes32, IPool, IPool, address, uint256));
        require(
            knownPools[address(pool1)] && knownPools[address(pool2)],
            "RollProxy: Only known pools"
        ); // The pools are pools we know.
        require(
            msg.sender == address(pool2.fyDai()),
            "RollProxy: Restricted to known lenders"
        ); // The msg.sender is the fyDai from one of the pools we know, and that we know only calls `executeOnFlashMint` in a strict loop. Therefore we can trust `data`.

        pool2.buyDai(address(this), address(this), daiToBuy.toUint128()); // If the loan (maxFYDaiCost) is not enough for this, is because of slippage. Built-in protection.
        _bestRepay(collateral, pool1, user, daiToBuy);
        _borrowToTarget(collateral, pool2, user, maxFYDaiCost);

        // emit Event(); ?
    }

    /// @dev Borrow so that this contract holds a target balance of a given fyDai (matching the one in the pool)
    function _borrowToTarget(bytes32 collateral, IPool pool, address user, uint256 targetFYDai) private {
        uint256 fyDaiBalance = pool.fyDai().balanceOf(address(this));
        controller.borrow(
            collateral,
            pool.fyDai().maturity(),
            user,
            address(this),
            targetFYDai > fyDaiBalance ? targetFYDai - fyDaiBalance : 0 // TODO: Can this be abused?
        );
    }

    /// @dev Repay debt (denominated in Dai) either directly in Dai or in FYDai bought at a pool, depending on whether the fyDai has matured
    function _bestRepay(bytes32 collateral, IPool pool, address user, uint256 debtRepaid) private {
        uint256 maturity = pool.fyDai().maturity();

        if (block.timestamp >= maturity){
            controller.repayDai(
                collateral,
                maturity,
                address(this),
                user,
                debtRepaid
            );
        } else {
            uint256 fyDaiDebtToRepay = pool.sellDai(address(this), address(this), debtRepaid.toUint128());
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
