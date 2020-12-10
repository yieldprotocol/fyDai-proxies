// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.10;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./interfaces/IController.sol";
import "./interfaces/IWeth.sol";
import "./interfaces/IGemJoin.sol";
import "./interfaces/IDaiJoin.sol";
import "./interfaces/IVat.sol";
import "./interfaces/ICDPMgr.sol";
import "./interfaces/IPool.sol";
import "./interfaces/IFYDai.sol";
import "./interfaces/IFlashMinter.sol";
import "./helpers/DecimalMath.sol";
import "./helpers/SafeCast.sol";
import "./helpers/YieldAuth.sol";
import "@nomiclabs/buidler/console.sol";


interface IImportCdpProxy {
    function importCdpFromProxy(IPool, address, uint256, uint256, uint256) external;
    function give(uint, address) external;
}

interface IProxyRegistry {
    function proxies(address) external view returns (address);
}

contract ImportCdpProxy is DecimalMath, IFlashMinter {
    using SafeCast for uint256;
    using YieldAuth for IController;

    IVat public immutable vat;
    ICDPMgr public immutable cdpMgr;
    IWeth public immutable weth;
    IERC20 public immutable dai;
    IGemJoin public immutable wethJoin;
    IDaiJoin public immutable daiJoin;
    IController public immutable controller;
    address public immutable treasury;
    IImportCdpProxy public immutable importCdpProxy;
    IProxyRegistry public immutable proxyRegistry;

    bytes32 public constant WETH = "ETH-A";
    bool public constant MTY = true;

    constructor(IController controller_, IPool[] memory pools_, IProxyRegistry proxyRegistry_, ICDPMgr cdpMgr_) public {
        ITreasury _treasury = controller_.treasury();

        IVat _vat = _treasury.vat();
        IWeth _weth = _treasury.weth();
        IERC20 _dai = _treasury.dai();
        address _daiJoin = address(_treasury.daiJoin());
        address _wethJoin = address(_treasury.wethJoin());
        

        controller = controller_;
        treasury = address(_treasury);
        importCdpProxy = IImportCdpProxy(address(this)); // This contract has two functions, as itself, and delegatecalled by a dsproxy.

        cdpMgr = cdpMgr_;
        proxyRegistry = proxyRegistry_;

        // Allow pool to take fyDai for trading
        for (uint i = 0 ; i < pools_.length; i++) {
            pools_[i].fyDai().approve(address(pools_[i]), type(uint256).max);
        }

        // Allow treasury to take weth for posting
        _weth.approve(address(_treasury), type(uint256).max);

        // Allow wethJoin to move weth out of vat for this proxy
        _vat.hope(_wethJoin);

        // Allow daiJoin to take Dai for paying debt
        _dai.approve(_daiJoin, type(uint256).max);

        vat = _vat;
        weth = _weth;
        dai = _dai;
        daiJoin = IDaiJoin(_daiJoin);
        wethJoin = IGemJoin(_wethJoin);
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
    function importCdpPosition(IPool pool, uint256 cdp, uint256 wethAmount, uint256 debtAmount) public {
        address user = cdpMgr.owns(cdp);
        require(user == msg.sender || proxyRegistry.proxies(user) == msg.sender, "ImportCdpProxy: Restricted to user or its dsproxy"); // Redundant?

        cdpMgr.give(cdp, address(importCdpProxy));           // Give the CDP to importCdpProxy
        importCdpProxy.importCdpFromProxy(pool, user, cdp, wethAmount, debtAmount); // Migrate part of the CDP to a Yield Vault
        importCdpProxy.give(cdp, user);                      // Return the rest of the CDP to its owner
    }

    /// @dev Migrate a CDPMgr-controlled MakerDAO vault to Yield.
    /// This function can be called from a dsproxy that already has a `vat.hope` on the user's MakerDAO Vault
    /// @param pool fyDai Pool to use for migration, determining maturity of the Yield Vault
    /// @param cdp CDP Vault to import
    function importCdp(IPool pool, uint256 cdp) public {
        (uint256 ink, uint256 art) = vat.urns(WETH, cdpMgr.urns(cdp));
        importCdpPosition(pool, cdp, ink, art);
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
    function importCdpFromProxy(IPool pool, address user, uint256 cdp, uint256 wethAmount, uint256 debtAmount) public {
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
        // Flash mint the fyDai
        IFYDai fyDai = pool.fyDai();
        (, uint256 rate,,,) = vat.ilks(WETH);
        fyDai.flashMint(
            fyDaiForDai(pool, muld(debtAmount, rate)),
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

    /// @dev Convert from MakerDAO debt to Dai
    function debtToDai(uint256 daiAmount) public view returns (uint256) {
        (, uint256 rate,,,) = vat.ilks(WETH);
        return muld(daiAmount, rate);
    }

    /// @dev Convert from Dai to MakerDAO debt
    function daiToDebt(uint256 daiAmount) public view returns (uint256) {
        (, uint256 rate,,,) = vat.ilks(WETH);
        return divd(daiAmount, rate);
    }

    /// @dev Minimum weth needed to collateralize an amount of dai in MakerDAO
    function wethForDai(uint256 daiAmount) public view returns (uint256) {
        (,, uint256 spot,,) = vat.ilks(WETH);
        return divd(daiAmount, spot);
    }

    /// @dev Minimum weth needed to collateralize an amount of fyDai in Yield. Yes, it's the same formula.
    function wethForFYDai(uint256 fyDaiAmount) public view returns (uint256) {
        (,, uint256 spot,,) = vat.ilks(WETH);
        return divd(fyDaiAmount, spot);
    }

    /// @dev Amount of fyDai debt that will result from migrating Dai debt from MakerDAO to Yield
    function fyDaiForDai(IPool pool, uint256 daiAmount) public view returns (uint256) {
        return pool.buyDaiPreview(daiAmount.toUint128());
    }

    /// @dev Amount of dai debt that will result from migrating fyDai debt from Yield to MakerDAO
    function daiForFYDai(IPool pool, uint256 fyDaiAmount) public view returns (uint256) {
        return pool.buyFYDaiPreview(fyDaiAmount.toUint128());
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
        address user = cdpMgr.owns(cdp);
        bool approvals = cdpMgr.cdpCan(user, cdp, address(this)) == 1;
        bool controllerSig = controller.delegated(msg.sender, address(importCdpProxy));
        return (approvals, controllerSig);
    }

    /// @dev Transfer debt and collateral from MakerDAO to Yield
    /// Needs vat.hope(importCdpProxy.address, { from: user });
    /// @param pool The pool to trade in (and therefore fyDai series to borrow)
    /// @param cdp The CDP contaiinng the migrated debt and collateral, its owner will own the Yield vault.
    /// @param wethAmount weth to move from MakerDAO to Yield. Needs to be high enough to collateralize the dai debt in Yield,
    /// and low enough to make sure that debt left in MakerDAO is also collateralized.
    /// @param debtAmount dai debt to move from MakerDAO to Yield. Denominated in Dai (= art * rate)
    /// @param controllerSig packed signature for delegation of ImportCdpProxy (not dsproxy) in the controller. Ignored if '0x'.
    function importCdpPositionWithSignature(IPool pool, uint256 cdp, uint256 wethAmount, uint256 debtAmount, bytes memory controllerSig) public {
        address user = cdpMgr.owns(cdp);
        if (controllerSig.length > 0) controller.addDelegatePacked(user, address(importCdpProxy), controllerSig);
        return importCdpPosition(pool, cdp, wethAmount, debtAmount);
    }

    function importCdpWithSignature(IPool pool, uint256 cdp, bytes memory controllerSig) public {
        address user = cdpMgr.owns(cdp);
        if (controllerSig.length > 0) controller.addDelegatePacked(user, address(importCdpProxy), controllerSig);
        return importCdp(pool, cdp);
    }
}
