// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.10;

import "./interfaces/IDai.sol";
import "./interfaces/IPot.sol";
import "./interfaces/IChai.sol";
import "./interfaces/IFYDai.sol";
import "./interfaces/ITreasury.sol";
import "./interfaces/IController.sol";
import "./interfaces/IPool.sol";
import "./helpers/DecimalMath.sol";
import "./helpers/SafeCast.sol";
import "./helpers/YieldAuth.sol";
import "@nomiclabs/buidler/console.sol";


contract RollProxy is DecimalMath {
    using SafeCast for uint256;
    using YieldAuth for IController;
    using YieldAuth for IDai;
    using YieldAuth for IFYDai;
    using YieldAuth for IPool;

    IDai public immutable dai;
    IPot public immutable pot;
    IChai public immutable chai;
    IController public immutable controller;
    address immutable treasury;

    bytes32 public constant CHAI = "CHAI";

    constructor(IController _controller) public {
        ITreasury _treasury = _controller.treasury();
        dai = _treasury.dai();
        pot = _treasury.pot();
        chai = _treasury.chai();
        treasury = address(_treasury);
        controller = _controller;
    }

    /* For different series
    z1 = p * (Z1 / (s))
    y1 = p * (Y1 / (s))
    z2 = ((z1 + c1 * y1) * Z2) / (Y2 + Z2)
    z2y2 = (z1 + c1 * y1) - z2
    y2 = ((z1 + c1 * y1) - z2) * c2
    */


    // Migrate assumes that the series is the same in both pools
    function migrateLiquidity(IPool pool1, IPool pool2, uint256 poolTokens) public returns (uint256 minted) {
        IFYDai fyDai = pool1.fyDai();
        require(fyDai == pool2.fyDai(), "RollProxy: Migrate between same series");

        uint256 daiReserves = dai.balanceOf(address(pool2));
        uint256 fyDaiReserves = fyDai.balanceOf(address(pool2));

        // remove liquidity
        (uint256 daiObtained, uint256 fyDaiObtained) = pool1.burn(msg.sender, address(this), poolTokens);
        uint256 daiProportion1 = daiObtained.div(daiObtained.add(fyDaiObtained));
        uint256 daiProportion2 = daiReserves.div(daiReserves.add(fyDaiReserves));

        if (daiProportion1 <= daiProportion2) {
            minted = pool2.mint(address(this), msg.sender, daiObtained);
            controller.repayFYDai(CHAI, fyDai.maturity(), address(this), msg.sender, fyDai.balanceOf(address(this)));
        } else {
            uint256 daiToAdd = fyDaiObtained.div(fyDaiReserves.div(fyDaiReserves.add(daiReserves)));
            minted = pool2.mint(address(this), msg.sender, daiToAdd);
            controller.repayDai(CHAI, fyDai.maturity(), address(this), msg.sender, dai.balanceOf(address(this)));
        }
            
        withdrawAssets();
    }

    /// @dev Return to caller all posted chai if there is no debt, converted to dai, plus any dai remaining in the contract.
    function withdrawAssets() internal {
        uint256 posted = controller.posted(CHAI, msg.sender);
        uint256 locked = controller.locked(CHAI, msg.sender);
        require (posted >= locked, "RollProxy: Undercollateralized");
        controller.withdraw(CHAI, msg.sender, address(this), posted - locked);
        chai.exit(address(this), chai.balanceOf(address(this)));
        require(dai.transfer(msg.sender, dai.balanceOf(address(this))), "PoolProxy: Dai Transfer Failed");
    }

    /// --------------------------------------------------
    /// Signature method wrappers
    /// --------------------------------------------------

    /// @dev Determine whether all approvals and signatures are in place for `migrateLiquidity`.
    /// If `return[0]` is `false`, calling `migrateLiquidityyWithSignature` will set the proxy approvals.
    /// If `return[1]` is `false`, `migrateLiquidityWithSignature` must be called with a controller delegation signature.
    /// If `return[2]` is `false`, `migrateLiquidityWithSignature` must be called with a pool1 delegation signature.
    /// If `return[3]` is `false`, `migrateLiquidityWithSignature` must be called with a pool2 delegation signature.
    /// If `return` is `(true, true, true, true)`, `migrateLiquidity` won't fail because of missing approvals or signatures.
    function migrateLiquidityCheck(IPool pool1, IPool pool2) public view returns (bool, bool, bool, bool) {
        bool approvals = true;
        approvals = approvals && dai.allowance(address(this), treasury) == type(uint256).max;
        approvals = approvals && chai.allowance(address(this), address(chai)) == type(uint256).max;
        approvals = approvals && dai.allowance(address(this), address(pool2)) == type(uint256).max;
        bool controllerSig = controller.delegated(msg.sender, address(this));
        bool poolSig1 = pool1.delegated(msg.sender, address(this));
        bool poolSig2 = pool2.delegated(msg.sender, address(this));
        return (approvals, controllerSig, poolSig1, poolSig2);
    }

    /// @dev Set proxy approvals for `migrateLiquidity` with a given pool pair.
    function migrateLiquidityApprove(IPool, IPool pool2) public {
        // Allow the Treasury to take dai when repaying
        if (dai.allowance(address(this), treasury) < type(uint256).max) dai.approve(treasury, type(uint256).max);

        // Allow Chai to take chai for unwrapping
        if (chai.allowance(address(this), address(chai)) < type(uint256).max) chai.approve(address(chai), type(uint256).max);

        // Allow pool 2 to take dai for minting
        if (dai.allowance(address(this), address(pool2)) < type(uint256).max) dai.approve(address(pool2), type(uint256).max);
    }

    /// @dev Mints liquidity with provided Dai by borrowing fyDai with some of the Dai.
    /// Caller must have approved the proxy using`controller.addDelegate(poolProxy)`
    /// Caller must have approved the dai transfer with `dai.approve(daiUsed)`
    // @param daiUsed amount of Dai to use to mint liquidity. 
    // @param maxFYDai maximum amount of fyDai to be borrowed to mint liquidity.
    // @param daiSig packed signature for permit of dai transfers to this proxy. Ignored if '0x'.
    // @param controllerSig packed signature for delegation of this proxy in the controller. Ignored if '0x'.
    /// @return The amount of liquidity tokens minted.  
    function migrateLiquidityWithSignature(
        IPool pool1,
        IPool pool2,
        uint256 poolTokens,
        // uint256 daiUsed,
        // uint256 maxFYDai,
        bytes memory controllerSig,
        bytes memory poolSig1,
        bytes memory poolSig2
    ) external returns (uint256) {
        migrateLiquidityApprove(pool1, pool2);
        if (controllerSig.length > 0) controller.addDelegatePacked(controllerSig);
        if (poolSig1.length > 0) pool1.addDelegatePacked(poolSig1);
        if (poolSig2.length > 0) pool2.addDelegatePacked(poolSig2);
        return migrateLiquidity(pool1, pool2, poolTokens);
    }
}
