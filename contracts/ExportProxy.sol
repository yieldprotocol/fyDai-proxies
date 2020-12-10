// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.10;

import "./interfaces/IFlashMinter.sol";
import "./helpers/DecimalMath.sol";
import "./helpers/SafeCast.sol";
import "./helpers/YieldAuth.sol";
import "./ExportProxyBase.sol";


contract ExportProxy is ExportProxyBase, DecimalMath, IFlashMinter {
    using SafeCast for uint256;
    using YieldAuth for IController;

    constructor(IController controller_, IPool[] memory pools_)
        public
        ExportProxyBase(controller_, pools_)
    { }

    /// @dev Transfer debt and collateral from Yield to MakerDAO
    /// Needs vat.hope(splitter.address, { from: user });
    /// Needs controller.addDelegate(splitter.address, { from: user });
    /// @notice This method won't work if executed via `delegatecall`, for example using dsproxy.
    /// @param pool The pool to trade in (and therefore fyDai series to migrate)
    /// @param wethAmount weth to move from Yield to MakerDAO. Needs to be high enough to collateralize the dai debt in MakerDAO,
    /// and low enough to make sure that debt left in Yield is also collateralized.
    /// @param fyDaiAmount fyDai debt to move from Yield to MakerDAO.
    /// @param maxFYDaiPrice Maximum Dai price to pay for fyDai.
    function exportPosition(IPool pool, uint256 wethAmount, uint256 fyDaiAmount, uint256 maxFYDaiPrice) public {
        IFYDai fyDai = pool.fyDai();

        // The user specifies the fyDai he wants to move, and the weth to be passed on as collateral
        require(
            fyDaiAmount <= controller.debtFYDai(WETH, fyDai.maturity(), msg.sender),
            "ExportProxy: Not enough debt in Yield"
        );
        require(
            wethAmount <= controller.posted(WETH, msg.sender),
            "ExportProxy: Not enough collateral in Yield"
        );
        // Flash mint the fyDai
        fyDai.flashMint(
            fyDaiAmount,
            abi.encode(pool, msg.sender, wethAmount, maxFYDaiPrice)
        ); // The daiAmount encoded is ignored
    }

    /// @dev Callback from `FYDai.flashMint()`
    /// @param fyDaiAmount fyDai debt to move from Yield to MakerDAO.
    /// @param data Packed structure with pool, user, weth collateral to move, and maximum Dai price to pay for fyDai.
    function executeOnFlashMint(uint256 fyDaiAmount, bytes calldata data) external override {
        (IPool pool, address user, uint256 wethAmount, uint256 maxFYDaiPrice) = 
            abi.decode(data, (IPool, address, uint256, uint256));
        require(msg.sender == address(IPool(pool).fyDai()), "ExportProxy: Restricted callback");

        _exportPosition(pool, user, wethAmount, fyDaiAmount, maxFYDaiPrice);
    }

    /// @dev Internal function to transfer debt and collateral from Yield to MakerDAO
    /// Needs vat.hope(splitter.address, { from: user });
    /// Needs controller.addDelegate(splitter.address, { from: user });
    /// @param pool The pool to trade in (and therefore fyDai series to migrate)
    /// @param user Vault to migrate.
    /// @param wethAmount weth to move from Yield to MakerDAO. Needs to be high enough to collateralize the dai debt in MakerDAO,
    /// and low enough to make sure that debt left in Yield is also collateralized.
    /// @param fyDaiAmount fyDai debt to move from Yield to MakerDAO.
    /// @param maxFYDaiPrice Maximum Dai price to pay for fyDai.
    function _exportPosition(IPool pool, address user, uint256 wethAmount, uint256 fyDaiAmount, uint256 maxFYDaiPrice) internal {
        // We are going to need to buy the FYDai back with Dai borrowed from Maker
        uint256 daiAmount = pool.buyFYDaiPreview(fyDaiAmount.toUint128());
        require(
            daiAmount <= muld(fyDaiAmount, maxFYDaiPrice),
            "ExportProxy: Maximum fyDai price exceeded"
        );
        
        IFYDai fyDai = IFYDai(pool.fyDai());

        // Pay the Yield debt - ExportProxy pays FYDai to remove the debt of `user`
        // Controller should take exactly all fyDai flash minted.
        controller.repayFYDai(WETH, fyDai.maturity(), address(this), user, fyDaiAmount);

        // Withdraw the collateral from Yield, ExportProxy will hold it
        controller.withdraw(WETH, user, address(this), wethAmount);

        // Post the collateral to Maker, in the `user` vault
        wethJoin.join(user, wethAmount);

        // Borrow the Dai from Maker
        (, uint256 rate,,,) = vat.ilks(WETH); // Retrieve the MakerDAO stability fee for Weth
        vat.frob(
            "ETH-A",
            user,
            user,
            user,
            wethAmount.toInt256(),                   // Adding Weth collateral
            divdrup(daiAmount, rate).toInt256()      // Adding Dai debt
        );
        vat.move(user, address(this), daiAmount.mul(UNIT)); // Transfer the Dai to ExportProxy within MakerDAO, in RAD
        daiJoin.exit(address(this), daiAmount);             // ExportProxy will hold the dai temporarily

        // Sell the Dai for FYDai at Pool - It should make up for what was taken with repayYdai
        pool.buyFYDai(address(this), address(this), fyDaiAmount.toUint128());
    }

    /// --------------------------------------------------
    /// Signature method wrappers
    /// --------------------------------------------------

    /// @dev Determine whether all approvals and signatures are in place for `exportPosition`.
    /// If `return[0]` is `false`, calling `vat.hope(exportProxy.address)` will set the MakerDAO approval.
    /// If `return[1]` is `false`, `exportPositionWithSignature` must be called with a controller signature.
    /// If `return` is `(true, true)`, `exportPosition` won't fail because of missing approvals or signatures.
    function exportPositionCheck() public view returns (bool, bool) {
        bool approvals = vat.can(msg.sender, address(this)) == 1;
        bool controllerSig = controller.delegated(msg.sender, address(this));
        return (approvals, controllerSig);
    }

    /// @dev Transfer debt and collateral from Yield to MakerDAO
    /// Needs vat.hope(exportProxy.address, { from: user });
    /// @param pool The pool to trade in (and therefore fyDai series to migrate)
    /// @param wethAmount weth to move from Yield to MakerDAO. Needs to be high enough to collateralize the dai debt in MakerDAO,
    /// and low enough to make sure that debt left in Yield is also collateralized.
    /// @param fyDaiAmount fyDai debt to move from Yield to MakerDAO.
    /// @param maxFYDaiPrice Maximum Dai price to pay for fyDai.
    /// @param controllerSig packed signature for delegation of this proxy in the controller. Ignored if '0x'.
    function exportPositionWithSignature(IPool pool, uint256 wethAmount, uint256 fyDaiAmount, uint256 maxFYDaiPrice, bytes memory controllerSig) public {
        if (controllerSig.length > 0) controller.addDelegatePacked(controllerSig);
        return exportPosition(pool, wethAmount, fyDaiAmount, maxFYDaiPrice);
    }
}
