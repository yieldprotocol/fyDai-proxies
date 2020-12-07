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
    function migrateLiquidity(IPool pool1, IPool pool2, uint256 poolTokens) public returns (uint256) {
        IFYDai fyDai = pool1.fyDai();
        require(fyDai == pool2.fyDai(), "RollProxy: Migrate between same series");

        // First we need to know the dai/fyDai balances of pool1 and pool2.
        // If pool1 dai/fyDai > pool2 dai/fyDai we will sell dai for fyDai in pool2
        // If pool1 dai/fyDai < pool2 dai/fyDai we will buy dai for fyDai in pool1
        uint256 daiReserves = dai.balanceOf(address(pool2));
        uint256 fyDaiReserves = fyDai.balanceOf(address(pool2));

        // Z1 = pool 1 dai reserves
        // Y1 = pool 1 fyDai reserves
        // Z2 = pool 2 dai reserves
        // Y2 = pool 2 fyDai reserves
        // z1 = dai obtained from burn
        // y1 = fyDai obtained from burn
        // z2 = dai required to mint
        // y2 = fyDai required to mint

        // z1 = p * (Z1 / s)                 : Obtained from burn
        // y1 = p * (Y1 / s)                 : Obtained from burn
        // z2 = ((z1 + y1) * Z2) / (Y2 + Z2) 
        // y2 = ((z1 + y1) - z2)             : Or, y2 = ((z1 + y1) * Y2) / (Y2 + Z2)

        // remove liquidity
        (uint256 daiObtained, uint256 fyDaiObtained) = pool1.burn(msg.sender, address(this), poolTokens);

        uint256 daiToAdd = (daiObtained.add(fyDaiObtained)).mul(daiReserves).div(fyDaiReserves.add(daiReserves));
        uint256 daiToConvert = (daiObtained.add(fyDaiObtained)).sub(daiToAdd); // Before maturity, so 1 Dai == 1 fyDai in the Controller

        if (daiObtained > daiToConvert) { // Meaning pool1 dai/fyDai > pool2 dai/fyDai. We have a dai surplus that we use to borrow more fyDai.
            // Convert (daiObtained - daiToConvert) to Chai and use it to borrow more fyDai
            chai.join(address(this), daiObtained.sub(daiToConvert));
            // look at the balance of chai in dai to avoid rounding issues
            uint256 toBorrow = chai.dai(address(this));
            controller.post(CHAI, address(this), msg.sender, chai.balanceOf(address(this)));
            controller.borrow(CHAI, fyDai.maturity(), msg.sender, address(this), toBorrow);
        } else { // Meaning pool1 dai/fyDai < pool2 dai/fyDai. We have a dai shortage so we repay debt with fyDai, withdraw chai collateral, and obtain dai.
            // Repay (daiToConvert - daiObtained) with fyDai, withdraw the Chai, and unwrap it to Dai
            uint256 debtToRepay = daiToConvert.sub(daiObtained);
            uint256 debtInChai = debtToRepay.div(pot.chi());
            controller.repayFYDai(CHAI, fyDai.maturity(), address(this), msg.sender, debtToRepay);
            controller.withdraw(CHAI, msg.sender, address(this), debtInChai);
            chai.exit(address(this), debtInChai);
        }

        // mint liquidity tokens
        return pool2.mint(address(this), msg.sender, daiToAdd);
    }

    /// --------------------------------------------------
    /// Signature method wrappers
    /// --------------------------------------------------

    /// @dev Determine whether all approvals and signatures are in place for `addLiquidity`.
    /// If `return[0]` is `false`, calling `addLiquidityWithSignature` will set the proxy approvals.
    /// If `return[1]` is `false`, `addLiquidityWithSignature` must be called with a dai permit signature.
    /// If `return[2]` is `false`, `addLiquidityWithSignature` must be called with a controller signature.
    /// If `return` is `(true, true, true)`, `addLiquidity` won't fail because of missing approvals or signatures.
    function migrateLiquidityCheck(IPool pool1, IPool pool2) public view returns (bool, bool, bool) {
        /* bool approvals = true;
        approvals = approvals && chai.allowance(address(this), treasury) == type(uint256).max;
        approvals = approvals && dai.allowance(address(this), address(chai)) == type(uint256).max;
        approvals = approvals && dai.allowance(address(this), address(pool)) == type(uint256).max;
        approvals = approvals && pool.fyDai().allowance(address(this), address(pool)) >= type(uint112).max;
        bool daiSig = dai.allowance(msg.sender, address(this)) == type(uint256).max;
        bool controllerSig = controller.delegated(msg.sender, address(this));
        return (approvals, daiSig, controllerSig); */
        return (false, false, false);
    }

    /// @dev Set proxy approvals for `addLiquidity` with a given pool.
    function migrateLiquidityApprove(IPool pool1, IPool pool2) public {
        // Allow the Treasury to take chai when posting
        // if (chai.allowance(address(this), treasury) < type(uint256).max) chai.approve(treasury, type(uint256).max);

        // Allow Chai to take dai for wrapping
        // if (dai.allowance(address(this), address(chai)) < type(uint256).max) dai.approve(address(chai), type(uint256).max);

        // Allow pool to take dai for minting
        // if (dai.allowance(address(this), address(pool)) < type(uint256).max) dai.approve(address(pool), type(uint256).max);

        // Allow pool to take fyDai for minting
        // if (pool.fyDai().allowance(address(this), address(pool)) < type(uint112).max) pool.fyDai().approve(address(pool), type(uint256).max);
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
        uint256 poolTokens
        // uint256 daiUsed,
        // uint256 maxFYDai,
        // bytes memory daiSig,
        // bytes memory controllerSig
    ) external returns (uint256) {
        migrateLiquidityApprove(pool1, pool2);
        // if (daiSig.length > 0) dai.permitPackedDai(address(this), daiSig);
        // if (controllerSig.length > 0) controller.addDelegatePacked(controllerSig);
        return migrateLiquidity(pool1, pool2, poolTokens);
    }
}
