// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.10;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./interfaces/IFYDai.sol";
import "./interfaces/IPool.sol";
import "./helpers/DecimalMath.sol";
import "./helpers/SafeCast.sol";
import "./helpers/YieldAuth.sol";


interface IStrategy {
    function mint(address to) external returns (uint256 minted);
}

contract MigrateLiquidityProxy is DecimalMath {
    using SafeCast for uint256;
    using YieldAuth for IPool;

    /// @dev Burns tokens, sells any fyDai for Dai, sends all obtained Dai to a Strategy, mints Strategy tokens for the user.
    /// @param pool Pool to burn LP tokens from.
    /// @param strategy Strategy to mint LP tokens from.
    /// @param poolTokens amount of pool tokens to burn. 
    /// @param minimumFYDaiPrice minimum Dai/fyDai price to be accepted when internally selling fyDai.
    /// @param poolSig packed signature for delegation of this proxy in a pool. Ignored if '0x'.
    function migrateLiquidity(IPool pool, IStrategy strategy, uint256 poolTokens, uint256 minimumFYDaiPrice, bytes memory poolSig) public {
        if (poolSig.length > 0) pool.addDelegatePacked(poolSig);

        IERC20 dai = pool.dai();
        IFYDai fyDai = pool.fyDai();

        (uint256 daiObtained, uint256 fyDaiObtained) = pool.burn(msg.sender, address(this), poolTokens);
        uint256 daiFromFYDai;

        if (fyDai.maturity() > now) {
            fyDai.approve(address(pool), fyDaiObtained);
            daiFromFYDai = pool.sellFYDai(address(this), address(this), uint128(fyDaiObtained));
            require(
                daiFromFYDai >= muld(fyDaiObtained, minimumFYDaiPrice),
                "PoolProxy: minimumFYDaiPrice not reached"
            );
        } else {
            daiFromFYDai = fyDai.redeem(address(this), address(this), fyDaiObtained);
        }

        require(dai.transfer(address(strategy), daiObtained.add(daiFromFYDai)), "Dai Transfer Failed");

        strategy.mint(msg.sender);
    }
}
