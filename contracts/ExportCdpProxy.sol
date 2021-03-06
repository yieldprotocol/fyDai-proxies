// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.10;

import "./interfaces/ICDPMgr.sol";
import "./interfaces/IFlashMinter.sol";
import "./helpers/DecimalMath.sol";
import "./helpers/SafeCast.sol";
import "./helpers/YieldAuth.sol";
import "./ExportProxyBase.sol";


contract ExportCdpProxy is ExportProxyBase, DecimalMath, IFlashMinter {
    using SafeCast for uint256;
    using YieldAuth for IController;

    ICDPMgr public cdpMgr;

    constructor(IController controller_, IPool[] memory pools_, ICDPMgr cdpMgr_) ExportProxyBase(controller_, pools_) public {
        cdpMgr = cdpMgr_;
    }

    /// @dev Transfer debt and collateral from Yield to MakerDAO
    /// Needs vat.hope(splitter.address, { from: user });
    /// Needs controller.addDelegate(splitter.address, { from: user });
    /// @notice This method won't work if executed via `delegatecall`, for example using dsproxy.
    /// @param pool The pool to trade in (and therefore fyDai series to migrate)
    /// @param cdp CDP Vault to export to.
    /// @param wethAmount weth to move from Yield to MakerDAO. Needs to be high enough to collateralize the dai debt in MakerDAO,
    /// and low enough to make sure that debt left in Yield is also collateralized.
    /// @param fyDaiAmount fyDai debt to move from Yield to MakerDAO.
    /// @param maxFYDaiPrice Maximum Dai price to pay for fyDai.
    function exportCdpPosition(IPool pool, uint256 cdp, uint256 wethAmount, uint256 fyDaiAmount, uint256 maxFYDaiPrice) public {
        IFYDai fyDai = pool.fyDai();

        require(
            cdpMgr.owns(cdp) == msg.sender || cdpMgr.cdpCan(cdpMgr.owns(cdp), cdp, msg.sender) == 1,
            "ExportCdpProxy: User doesn't have rights to the target cdp"
        );
        // The user specifies the fyDai he wants to move, and the weth to be passed on as collateral
        require(
            fyDaiAmount <= controller.debtFYDai(WETH, fyDai.maturity(), msg.sender),
            "ExportCdpProxy: Not enough debt in Yield"
        );
        require(
            wethAmount <= controller.posted(WETH, msg.sender),
            "ExportCdpProxy: Not enough collateral in Yield"
        );
        // Flash mint the fyDai
        fyDai.flashMint(
            fyDaiAmount,
            abi.encode(pool, msg.sender, cdp, wethAmount, maxFYDaiPrice)
        ); // The daiAmount encoded is ignored
    }

    /// @dev Callback from `FYDai.flashMint()`
    /// @param fyDaiAmount fyDai debt to move from Yield to MakerDAO.
    /// @param data Packed structure with pool, user, cdp, weth collateral to move, and maximum Dai price to pay for fyDai.
    function executeOnFlashMint(uint256 fyDaiAmount, bytes calldata data) external override {
        (IPool pool, address user, uint256 cdp, uint256 wethAmount, uint256 maxFYDaiPrice) = 
            abi.decode(data, (IPool, address, uint256, uint256, uint256));
        require(msg.sender == address(IPool(pool).fyDai()), "ExportCdpProxy: Restricted callback");

        _exportCdpPosition(pool, user, cdp, wethAmount, fyDaiAmount, maxFYDaiPrice);
    }

    /// @dev Internal function to transfer debt and collateral from Yield to MakerDAO
    /// Needs vat.hope(splitter.address, { from: user });
    /// Needs controller.addDelegate(splitter.address, { from: user });
    /// @param pool The pool to trade in (and therefore fyDai series to migrate)
    /// @param user Vault to migrate.
    /// @param cdp CDP Vault to export to.
    /// @param wethAmount weth to move from Yield to MakerDAO. Needs to be high enough to collateralize the dai debt in MakerDAO,
    /// and low enough to make sure that debt left in Yield is also collateralized.
    /// @param fyDaiAmount fyDai debt to move from Yield to MakerDAO.
    /// @param maxFYDaiPrice Maximum Dai price to pay for fyDai.
    function _exportCdpPosition(IPool pool, address user, uint256 cdp, uint256 wethAmount, uint256 fyDaiAmount, uint256 maxFYDaiPrice) internal {
        // We are going to need to buy the FYDai back with Dai borrowed from Maker
        uint256 daiAmount = pool.buyFYDaiPreview(fyDaiAmount.toUint128());
        require(
            daiAmount <= muld(fyDaiAmount, maxFYDaiPrice),
            "ExportCdpProxy: Maximum fyDai price exceeded"
        );
        
        IFYDai fyDai = IFYDai(pool.fyDai());

        // Pay the Yield debt - ExportCdpProxy pays FYDai to remove the debt of `user`
        // Controller should take exactly all fyDai flash minted.
        controller.repayFYDai(WETH, fyDai.maturity(), address(this), user, fyDaiAmount);

        // Withdraw the collateral from Yield, ExportCdpProxy will hold it
        controller.withdraw(WETH, user, address(this), wethAmount);

        // Post the collateral to Maker, in the vault referenced by the cdp
        address urn = cdpMgr.urns(cdp);
        wethJoin.join(urn, wethAmount);

        // Borrow the Dai from Maker
        (, uint256 rate,,,) = vat.ilks(WETH); // Retrieve the MakerDAO stability fee for Weth
        cdpMgr.frob(
            cdp,
            wethAmount.toInt256(),                   // Adding Weth collateral
            divdrup(daiAmount, rate).toInt256()      // Adding Dai debt
        );
        cdpMgr.move(cdp, address(this), daiAmount.mul(UNIT)); // Transfer the Dai to ExportCdpProxy within MakerDAO, in RAD
        daiJoin.exit(address(this), daiAmount);             // ExportCdpProxy will hold the dai temporarily

        // Sell the Dai for FYDai at Pool - It should make up for what was taken with repayYdai
        pool.buyFYDai(address(this), address(this), fyDaiAmount.toUint128());
    }

    /// --------------------------------------------------
    /// Signature method wrappers
    /// --------------------------------------------------

    /// @dev Determine whether all approvals and signatures are in place for `exportCdpPosition`.
    /// @param cdp CDP Vault to export to.
    /// If `return[0]` is `false`, calling `cdpMgr.cdpAllow(cdp, exportCdpProxy.address, 1)` will set the MakerDAO approval.
    /// If `return[1]` is `false`, `exportCdpPositionWithSignature` must be called with a controller signature.
    /// If `return` is `(true, true)`, `exportCdpPosition` won't fail because of missing approvals or signatures.
    function exportCdpPositionCheck(uint256 cdp) public view returns (bool, bool) {
        bool approvals = cdpMgr.cdpCan(cdpMgr.owns(cdp), cdp, address(this)) == 1;
        bool controllerSig = controller.delegated(msg.sender, address(this));
        return (approvals, controllerSig);
    }

    /// @dev Transfer debt and collateral from Yield to MakerDAO
    /// Needs vat.hope(exportCdpProxy.address, { from: user });
    /// @param pool The pool to trade in (and therefore fyDai series to migrate).
    /// @param cdp CDP Vault to export to.
    /// @param wethAmount weth to move from Yield to MakerDAO. Needs to be high enough to collateralize the dai debt in MakerDAO,
    /// and low enough to make sure that debt left in Yield is also collateralized.
    /// @param fyDaiAmount fyDai debt to move from Yield to MakerDAO.
    /// @param maxFYDaiPrice Maximum Dai price to pay for fyDai.
    /// @param controllerSig packed signature for delegation of this proxy in the controller. Ignored if '0x'.
    function exportCdpPositionWithSignature(IPool pool, uint256 cdp, uint256 wethAmount, uint256 fyDaiAmount, uint256 maxFYDaiPrice, bytes memory controllerSig) public {
        if (controllerSig.length > 0) controller.addDelegatePacked(controllerSig);
        return exportCdpPosition(pool, cdp, wethAmount, fyDaiAmount, maxFYDaiPrice);
    }
}
