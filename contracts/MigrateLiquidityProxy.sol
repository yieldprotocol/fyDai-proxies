// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.10;

import "./interfaces/IDai.sol";
import "./interfaces/IPool.sol";
import "./interfaces/IFYDai.sol";
import "./interfaces/ITreasury.sol";
import "./helpers/DecimalMath.sol";
import "./helpers/SafeCast.sol";
import "./helpers/YieldAuth.sol";


interface IStrategy {
    function mint(address to) external returns (uint256 minted);
}

contract MigrateLiquidityProxy is DecimalMath {
    using SafeCast for uint256;
    using YieldAuth for IDai;
    using YieldAuth for IFYDai;
    using YieldAuth for IPool;

    IDai public immutable dai;
    IStrategy public immutable strategy;

    constructor(ITreasury _treasury, IStrategy _strategy) public {
        strategy = _strategy;
        IDai _dai = _treasury.dai();
        _dai.approve(treasury, type(uint256).max);
        dai = _dai;
    }

    /// @dev Burns tokens, sells any fyDai for Dai, sends all obtained Dai to a Strategy, mints Strategy tokens for the user.
    /// Caller must have approved the proxy with `pool.addDelegate(poolProxy)` or with `removeLiquidityEarlyWithSignature`
    /// Caller must have called `removeLiquidityEarlyDaiFixedWithSignature` at least once before to set proxy approvals.
    /// @param poolTokens amount of pool tokens to burn. 
    /// @param minimumFYDaiPrice minimum Dai/fyDai price to be accepted when internally selling fyDai.
    function removeLiquidityEarly(IPool pool, uint256 poolTokens, uint256 minimumFYDaiPrice) public {
        IFYDai fyDai = pool.fyDai();
        uint256 maturity = fyDai.maturity();

        (uint256 daiObtained, uint256 fyDaiObtained) = pool.burn(msg.sender, address(this), poolTokens);
        uint256 daiFromFYDai = pool.sellFYDai(address(this), address(this), uint128(fyDaiObtained));

        require(
            daiFromFYDai >= muld(fyDaiObtained, minimumFYDaiPrice),
            "PoolProxy: minimumFYDaiPrice not reached"
        );
        require(dai.transfer(address(this), address(strategy), daiObtained.add(daiFromFYDai)), "PoolProxy: Dai Transfer Failed");

        strategy.mint(msg.sender);
    }

    /// @dev Burns tokens, redeems any fyDai for Dai, sends all obtained Dai to a Strategy, mints Strategy tokens for the user.
    /// Caller must have approved the proxy with `pool.addDelegate(poolProxy)` or with `removeLiquidityEarlyWithSignature`
    /// @param poolTokens amount of pool tokens to burn.
    function removeLiquidityMature(IPool pool, uint256 poolTokens) public {

        IFYDai fyDai = pool.fyDai();
        uint256 maturity = fyDai.maturity();

        (uint256 daiObtained, uint256 fyDaiObtained) = pool.burn(msg.sender, address(this), poolTokens);
        daiFromFYDai = fyDai.redeem(address(this), address(this), fyDaiObtained);
        require(dai.transfer(address(this), address(strategy), daiObtained.add(daiFromFYDai)), "PoolProxy: Dai Transfer Failed");

        strategy.mint(msg.sender);
    }

    /// --------------------------------------------------
    /// Signature method wrappers
    /// --------------------------------------------------

    /// @dev Burns tokens and repays debt with proceedings. Sells any excess fyDai for Dai, then returns all Dai, and all unlocked Chai.
    /// @param poolTokens amount of pool tokens to burn. 
    /// @param minimumFYDaiPrice minimum Dai/fyDai price to be accepted when internally selling fyDai.
    /// @param poolSig packed signature for delegation of this proxy in a pool. Ignored if '0x'.
    function removeLiquidityEarlyWithSignature(
        IPool pool,
        uint256 poolTokens,
        uint256 minimumFYDaiPrice,
        bytes memory poolSig
    ) public {
        if (pool.fyDai().allowance(address(this), address(pool)) < type(uint112).max) pool.fyDai().approve(address(pool), type(uint256).max);
        if (poolSig.length > 0) pool.addDelegatePacked(poolSig);
        removeLiquidityEarly(pool, poolTokens, minimumFYDaiPrice);
    }

    /// @dev Burns tokens and repays fyDai debt after Maturity.
    /// @param poolTokens amount of pool tokens to burn.
    /// @param poolSig packed signature for delegation of this proxy in a pool. Ignored if '0x'.
    function removeLiquidityMatureWithSignature(
        IPool pool,
        uint256 poolTokens,
        bytes memory poolSig
    ) external {
        if (poolSig.length > 0) pool.addDelegatePacked(poolSig);
        removeLiquidityMature(pool, poolTokens);
    }
}
