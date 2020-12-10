// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.10;

import "./interfaces/ICDPMgr.sol";
import "./interfaces/IFlashMinter.sol";
import "./helpers/DecimalMath.sol";
import "./helpers/SafeCast.sol";
import "./helpers/YieldAuth.sol";
import "./ImportProxyBase.sol";


interface IImportCdpProxy {
    function importCdpFromProxy(IPool, address, uint256, uint256, uint256, uint256) external;
    function give(uint, address) external;
}

contract ImportCdpProxy is ImportProxyBase, DecimalMath, IFlashMinter {
    using SafeCast for uint256;
    using YieldAuth for IController;

    ICDPMgr public immutable cdpMgr;
    IImportCdpProxy public immutable importCdpProxy;

    constructor(IController controller_, IPool[] memory pools_, IProxyRegistry proxyRegistry_, ICDPMgr cdpMgr_)
        public
        ImportProxyBase(controller_, pools_, proxyRegistry_)
    {
        importCdpProxy = IImportCdpProxy(address(this)); // This contract has two functions, as itself, and delegatecalled by a dsproxy.
        cdpMgr = cdpMgr_;
    }

    /// --------------------------------------------------
    /// ImportCdpProxy via dsproxy: Fork and Split
    /// --------------------------------------------------

    /// @dev Migrate part of a CDPMgr-controlled MakerDAO vault to Yield.
    /// This function can be called from a dsproxy that already has a `vat.hope` on the user's MakerDAO Vault
    /// @param pool fyDai Pool to use for migration, determining maturity of the Yield Vault
    // @param user User owning the CDP Vault to import
    /// @param cdp CDP Vault to import
    /// @param wethAmount Weth collateral to import
    /// @param debtAmount Normalized debt to move ndai * rate = dai
    /// @param maxDaiPrice Maximum fyDai price to pay for Dai
    function importCdpPosition(IPool pool, uint256 cdp, uint256 wethAmount, uint256 debtAmount, uint256 maxDaiPrice) public {
        address user = cdpMgr.owns(cdp);
        require(user == msg.sender || proxyRegistry.proxies(user) == msg.sender, "ImportCdpProxy: Restricted to user or its dsproxy"); // Redundant?

        cdpMgr.give(cdp, address(importCdpProxy));           // Give the CDP to importCdpProxy
        importCdpProxy.importCdpFromProxy(pool, user, cdp, wethAmount, debtAmount, maxDaiPrice); // Migrate part of the CDP to a Yield Vault
        importCdpProxy.give(cdp, user);                      // Return the rest of the CDP to its owner
    }

    /// @dev Migrate a CDPMgr-controlled MakerDAO vault to Yield.
    /// This function can be called from a dsproxy that already has a `vat.hope` on the user's MakerDAO Vault
    /// @param pool fyDai Pool to use for migration, determining maturity of the Yield Vault
    /// @param cdp CDP Vault to import
    /// @param maxDaiPrice Maximum fyDai price to pay for Dai
    function importCdp(IPool pool, uint256 cdp, uint256 maxDaiPrice) public {
        (uint256 ink, uint256 art) = vat.urns(WETH, cdpMgr.urns(cdp));
        importCdpPosition(pool, cdp, ink, art, maxDaiPrice);
    }

    /// --------------------------------------------------
    /// ImportCdpProxy as itself: Maker to Yield proxy
    /// --------------------------------------------------

    /// @dev ImportCdpProxy will freely give away any cdps it owns
    function give(uint256 cdp, address user) public {
        cdpMgr.give(cdp, user);
    }

    /// @dev Transfer debt and collateral from MakerDAO (this contract's CDP) to Yield (user's CDP)
    /// Needs controller.addDelegate(importCdpProxy.address, { from: user });
    /// @param pool The pool to trade in (and therefore fyDai series to borrow)
    /// @param user The user to receive the debt and collateral in Yield
    /// @param cdp The The CDP id containing the debt and collateral to migrate
    /// @param wethAmount weth to move from MakerDAO to Yield. Needs to be high enough to collateralize the dai debt in Yield,
    /// and low enough to make sure that debt left in MakerDAO is also collateralized.
    /// @param debtAmount Normalized dai debt to move from MakerDAO to Yield. ndai * rate = dai
    /// @param maxDaiPrice Maximum fyDai price to pay for Dai
    function importCdpFromProxy(IPool pool, address user, uint256 cdp, uint256 wethAmount, uint256 debtAmount, uint256 maxDaiPrice) public {
        require(user == msg.sender || proxyRegistry.proxies(user) == msg.sender, "ImportCdpProxy: Restricted to user or its dsproxy");
        // The user specifies the fyDai he wants to mint to cover his maker debt, the weth to be passed on as collateral, and the dai debt to move
        (uint256 ink, uint256 art) = vat.urns(WETH, cdpMgr.urns(cdp)); // Should this require be in `importPosition`?
        require(
            debtAmount <= art,
            "ImportCdpProxy: Not enough debt in Maker"
        );
        require(
            wethAmount <= ink,
            "ImportCdpProxy: Not enough collateral in Maker"
        );
        (, uint256 rate,,,) = vat.ilks(WETH);
        uint256 daiNeeded = muld(debtAmount, rate);
        uint256 fyDaiAmount = pool.buyDaiPreview(daiNeeded.toUint128());
        require(
            fyDaiAmount <= muld(daiNeeded, maxDaiPrice),
            "ImportCdpProxy: Maximum Dai price exceeded"
        );

        // Flash mint the fyDai
        IFYDai fyDai = pool.fyDai();
        fyDai.flashMint(
            fyDaiAmount,
            abi.encode(pool, user, cdp, wethAmount, debtAmount)
        );
    }

    /// @dev Callback from `FYDai.flashMint()`
    function executeOnFlashMint(uint256, bytes calldata data) external override {
        (IPool pool, address user, uint256 cdp, uint256 wethAmount, uint256 debtAmount) = 
            abi.decode(data, (IPool, address, uint256, uint256, uint256));
        require(msg.sender == address(IPool(pool).fyDai()), "ImportCdpProxy: Callback restricted to the fyDai matching the pool");
        // require(vat.can(address(this), user) == 1, "ImportCdpProxy: Unauthorized by user");

        _importCdpFromProxy(pool, user, cdp, wethAmount, debtAmount);
    }

    /// @dev Internal function to transfer debt and collateral from MakerDAO to Yield
    /// @param pool The pool to trade in (and therefore fyDai series to borrow)
    /// @param user Yield Vault to receive the debt and collateral.
    /// @param cdp The The CDP id containing the debt and collateral to migrate
    /// @param wethAmount weth to move from MakerDAO to Yield. Needs to be high enough to collateralize the dai debt in Yield,
    /// and low enough to make sure that debt left in MakerDAO is also collateralized.
    /// @param debtAmount dai debt to move from MakerDAO to Yield. Denominated in Dai (= art * rate)
    /// Needs vat.hope(importCdpProxy.address, { from: user });
    /// Needs controller.addDelegate(importCdpProxy.address, { from: user });
    function _importCdpFromProxy(IPool pool, address user, uint256 cdp, uint256 wethAmount, uint256 debtAmount) internal {
        IFYDai fyDai = IFYDai(pool.fyDai());

        // Pool should take exactly all fyDai flash minted. ImportCdpProxy will hold the dai temporarily
        (, uint256 rate,,,) = vat.ilks(WETH);
        uint256 fyDaiSold = pool.buyDai(address(this), address(this), muld(debtAmount, rate).toUint128());

        // daiJoin.join(address(this), dai.balanceOf(address(this)));      // Put the Dai in Maker
        daiJoin.join(cdpMgr.urns(cdp), dai.balanceOf(address(this)));      // Put the Dai in Maker
        cdpMgr.frob(                           // Pay the debt and unlock collateral in Maker
            cdp,
            -wethAmount.toInt256(),               // Removing Weth collateral
            -debtAmount.toInt256()  // Removing Dai debt
        );
        cdpMgr.flux(cdp, address(this), wethAmount);
        wethJoin.exit(address(this), wethAmount);                       // Hold the weth in ImportCdpProxy
        controller.post(WETH, address(this), user, wethAmount);         // Add the collateral to Yield
        controller.borrow(WETH, fyDai.maturity(), user, address(this), fyDaiSold); // Borrow the fyDai
    }

    /// --------------------------------------------------
    /// Signature method wrappers
    /// --------------------------------------------------
    
    /// @dev Determine whether all approvals and signatures are in place for `importCdpPosition`.
    /// @param cdp MakerDAO CDP to import.
    /// If `return[0]` is `false`, calling `cdpMgr.cdpAllow(cdp, proxy.address, 1)` will set the MakerDAO approval.
    /// If `return[1]` is `false`, `importCdpFromProxyWithSignature` must be called with a controller signature.
    /// If `return` is `(true, true)`, `importCdpFromProxy` won't fail because of missing approvals or signatures.
    function importCdpPositionCheck(uint256 cdp) public view returns (bool, bool) {
        bool approvals = cdpMgr.cdpCan(cdpMgr.owns(cdp), cdp, address(this)) == 1;
        bool controllerSig = controller.delegated(msg.sender, address(importCdpProxy));
        return (approvals, controllerSig);
    }

    /// @dev Transfer debt and collateral from MakerDAO to Yield
    /// Needs `cdpMgr.cdpAllow(cdp, proxy.address, 1)`
    /// @param pool The pool to trade in (and therefore fyDai series to borrow)
    /// @param cdp The CDP containing the migrated debt and collateral, its owner will own the Yield vault.
    /// @param wethAmount weth to move from MakerDAO to Yield. Needs to be high enough to collateralize the dai debt in Yield,
    /// and low enough to make sure that debt left in MakerDAO is also collateralized.
    /// @param debtAmount dai debt to move from MakerDAO to Yield. Denominated in Dai (= art * rate)
    /// @param maxDaiPrice Maximum fyDai price to pay for Dai
    /// @param controllerSig packed signature for delegation of ImportCdpProxy (not dsproxy) in the controller. Ignored if '0x'.
    function importCdpPositionWithSignature(IPool pool, uint256 cdp, uint256 wethAmount, uint256 debtAmount, uint256 maxDaiPrice, bytes memory controllerSig) public {
        address user = cdpMgr.owns(cdp);
        if (controllerSig.length > 0) controller.addDelegatePacked(user, address(importCdpProxy), controllerSig);
        return importCdpPosition(pool, cdp, wethAmount, debtAmount, maxDaiPrice);
    }

    /// @dev Transfer a CDP from MakerDAO to Yield
    /// Needs `cdpMgr.cdpAllow(cdp, proxy.address, 1)`
    /// @param pool The pool to trade in (and therefore fyDai series to borrow)
    /// @param cdp The CDP containing the migrated debt and collateral, its owner will own the Yield vault.
    /// @param maxDaiPrice Maximum fyDai price to pay for Dai
    /// @param controllerSig packed signature for delegation of ImportCdpProxy (not dsproxy) in the controller. Ignored if '0x'.
    function importCdpWithSignature(IPool pool, uint256 cdp, uint256 maxDaiPrice, bytes memory controllerSig) public {
        address user = cdpMgr.owns(cdp);
        if (controllerSig.length > 0) controller.addDelegatePacked(user, address(importCdpProxy), controllerSig);
        return importCdp(pool, cdp, maxDaiPrice);
    }
}
