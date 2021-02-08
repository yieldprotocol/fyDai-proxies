// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.10;

import "./interfaces/IController.sol";
import "./interfaces/IFYDai.sol";
import "./interfaces/IPool.sol";
import "./interfaces/IProxyRegistry.sol";
import "./helpers/SafeCast.sol";
import "./helpers/YieldAuth.sol";
import "hardhat/console.sol";


/// @dev RollProxy migrates debt positions between two maturities of the v1 Yield Protocol.
contract RollProxy {
    using SafeCast for uint256;
    using YieldAuth for IController;

    event Rolled(bytes32 indexed collateral, address indexed pool1, address pool2, address indexed user, uint256 daiDebtRepaid);

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

    function validUser(address user) public view {
        require(
            user == msg.sender || proxyRegistry.proxies(user) == msg.sender,
            "RollProxy: Restricted to user or its dsproxy"
        );
    }

    function validPool(address pool) public view {
        require(
            knownPools[pool],
            "RollProxy: Only known pools"
        );
    }

    /// @dev Cost in Dai to repay a debt. Given that the debt is denominated in Dai at the time of maturity, this might be lower before then.
    /// @param collateral A Yield Protocol v1 collateral type (WETH/CHAI)
    /// @param pool The pool trading the maturity in which the debt is denominated.
    /// @param daiDebt The amount of Dai debt to query the Dai repayment cost, also in Dai.
    function daiCostToRepay(bytes32 collateral, IPool pool, uint256 daiDebt) public view returns(uint256 daiCost) {
        uint256 maturity = pool.maturity();

        if (block.timestamp >= maturity){
            daiCost = daiDebt; // After maturity we pay using Dai, that the debt grows doesn't matter
        } else {
            daiCost = pool.buyFYDaiPreview(
                controller.inFYDai(collateral, maturity, daiDebt).toUint128()
            );
        }        
    }

    /// @dev When repaying a whole vault before maturity, we will need to know how much Dai we will spend repaying the
    /// precise amount of fyDai debt.
    /// @notice If this function is not called within the same tx as `rollProxy` the amount returned won't be precise.
    function daiCostToClose(bytes32 collateral, IPool pool, address user) public view returns(uint256 daiCost) {
        uint256 maturity = pool.maturity();

        if (block.timestamp >= maturity){
            daiCost = controller.debtDai(collateral, maturity, user); // After maturity we pay using Dai, that the debt grows doesn't matter
        } else {
            daiCost = pool.buyFYDaiPreview(
                controller.debtFYDai(collateral, maturity, user).toUint128()
            );
        }        
    }

    /// @dev Roll debt from a mature series to a non-mature one
    /// @param collateral A Yield Protocol v1 collateral type (WETH/CHAI)
    /// @param pool1 The pool trading the maturity in which the debt is denominated.
    /// @param pool2 The pool trading the maturity in which the debt is being rolled to.
    /// @param user The user owning the Yield Protocol v1 debt vault.
    /// @param daiToBuy The amount of Dai to buy in pool2 to repay debt. Calculate off-chain using daiCostToRepay(collateral, pool1, daiDebtToRepay) or similar.
    /// @param maxFYDaiCost The maximum amount of fyDai debt that will be obtained to secure the new position. Calculate off-chain using pool2.buyDaiPreview(daiDebtToRepay.toUint128()), plus accepted slippage.
    function rollDebtAfterMaturity(
        bytes32 collateral,
        IPool pool1,
        IPool pool2,
        address user,
        uint256 daiToBuy,
        uint256 maxFYDaiCost
    )
        public 
    {
        validUser(user);
        validPool(address(pool1));
        validPool(address(pool2));

        bytes memory data = abi.encode(
            collateral,
            pool1,
            pool2,
            user,
            daiToBuy,
            bytes32("RDAM")
        );
        pool2.fyDai().flashMint(maxFYDaiCost, data); // Callback from fyDai will come back to this contract
    }

    /// @dev Roll debt from a non-mature series to another
    /// @param collateral A Yield Protocol v1 collateral type (WETH/CHAI)
    /// @param pool1 The pool trading the maturity in which the debt is denominated.
    /// @param pool2 The pool trading the maturity in which the debt is being rolled to.
    /// @param user The user owning the Yield Protocol v1 debt vault.
    /// @param daiToBuy The amount of Dai to buy in pool2 to repay debt. Calculate off-chain using daiCostToRepay(collateral, pool1, daiDebtToRepay) or similar.
    /// @param maxFYDaiCost The maximum amount of fyDai debt that will be obtained to secure the new position. Calculate off-chain using pool2.buyDaiPreview(daiDebtToRepay.toUint128()), plus accepted slippage.
    function rollDebtBeforeMaturity(
        bytes32 collateral,
        IPool pool1,
        IPool pool2,
        address user,
        uint256 daiToBuy,
        uint256 maxFYDaiCost
    ) public {
        validUser(user);
        validPool(address(pool1));
        validPool(address(pool2));

        bytes memory data = abi.encode(
            collateral,
            pool1,
            pool2,
            user,
            daiToBuy,
            bytes32("RDBM")
        );
        pool2.fyDai().flashMint(maxFYDaiCost, data); // Callback from fyDai will come back to this contract
    }

    /// @dev Roll all debt from one user and from one mature series to a non-mature series
    /// @param collateral A Yield Protocol v1 collateral type (WETH/CHAI)
    /// @param pool1 The pool trading the maturity in which the debt is denominated.
    /// @param pool2 The pool trading the maturity in which the debt is being rolled to.
    /// @param user The user owning the Yield Protocol v1 debt vault.
    /// @param maxFYDaiCost The maximum amount of fyDai debt that will be obtained to secure the new position. Calculate off-chain using pool2.buyDaiPreview(daiDebtToRepay.toUint128()), plus accepted slippage.
    function rollAllAfterMaturity(
        bytes32 collateral,
        IPool pool1,
        IPool pool2,
        address user,
        uint256 maxFYDaiCost
    ) public {
        validUser(user);
        validPool(address(pool1));
        validPool(address(pool2));

        bytes memory data = abi.encode(
            collateral,
            pool1,
            pool2,
            user,
            controller.debtDai(collateral, pool1.maturity(), user),
            bytes32("RAAM")
        );
        pool2.fyDai().flashMint(maxFYDaiCost, data); // Callback from fyDai will come back to this contract
    }

    /// @dev Roll all debt from one user and from one non-mature series to another non-mature series
    /// @param collateral A Yield Protocol v1 collateral type (WETH/CHAI)
    /// @param pool1 The pool trading the maturity in which the debt is denominated.
    /// @param pool2 The pool trading the maturity in which the debt is being rolled to.
    /// @param user The user owning the Yield Protocol v1 debt vault.
    /// @param maxFYDaiCost The maximum amount of fyDai debt that will be obtained to secure the new position. Calculate off-chain using pool2.buyDaiPreview(daiDebtToRepay.toUint128()), plus accepted slippage.
    function rollAllBeforeMaturity(
        bytes32 collateral,
        IPool pool1,
        IPool pool2,
        address user,
        uint256 maxFYDaiCost
    ) public {
        validUser(user);
        validPool(address(pool1));
        validPool(address(pool2));

        bytes memory data = abi.encode(
            collateral,
            pool1,
            pool2,
            user,
            pool1.buyFYDaiPreview(
                controller.debtFYDai(collateral, pool1.maturity(), user).toUint128()
            ),
            bytes32("RABM")
        );
        pool2.fyDai().flashMint(maxFYDaiCost, data); // Callback from fyDai will come back to this contract
    }


    /// @dev Flash loan callback, contains most of the logic
    /// @param maxFYDaiCost The maximum amount of fyDai debt that will be obtained to secure the new position. 
    /// @param data Packed parameter with all the other parameters from `rollDebt`.
    function executeOnFlashMint(
        uint256 maxFYDaiCost,
        bytes memory data
    )
        public
    {
        (bytes32 collateral, IPool pool1, IPool pool2, address user, uint256 daiToBuy, bytes32 rollType)
            = abi.decode(data, (bytes32, IPool, IPool, address, uint256, bytes32));
        require(
            knownPools[address(pool1)] && knownPools[address(pool2)],
            "RollProxy: Only known pools"
        ); // The pools are pools we know.
        require(
            msg.sender == address(pool2.fyDai()),
            "RollProxy: Restricted to known lenders"
        ); // The msg.sender is the fyDai from one of the pools we know, and that we know only calls `executeOnFlashMint` in a strict loop. Therefore we can trust `data`.

        pool2.buyDai(address(this), address(this), daiToBuy.toUint128()); // If the loan (maxFYDaiCost) is not enough for this, is because of slippage. Built-in protection.
        if (rollType == bytes32("RAAM") || rollType == bytes32("RDAM")) _repayAfterMaturity(collateral, pool1, user, daiToBuy); // We know the exact debt already for RAAM
        else if (rollType == bytes32("RABM")) _repayAllBeforeMaturity(collateral, pool1, user);
        else if (rollType == bytes32("RDBM")) _repayDebtBeforeMaturity(collateral, pool1, user, daiToBuy);
         
        _borrowToTarget(collateral, pool2, user, maxFYDaiCost);

        emit Rolled(collateral, address(pool1), address(pool2), user, daiToBuy);
    }

    /// @dev Repay debt with Dai. Use after maturity.
    /// @param collateral A Yield Protocol v1 collateral type (WETH/CHAI)
    /// @param pool The pool trading the maturity in which the debt is denominated.
    /// @param user The user owning the Yield Protocol v1 debt vault.
    /// @param debtRepaid The amount of Dai debt that should be repaid, with holdings from this proxy.
    function _repayAfterMaturity(bytes32 collateral, IPool pool, address user, uint256 debtRepaid) private {
        uint256 maturity = pool.maturity();

        controller.repayDai(
            collateral,
            maturity,
            address(this),
            user,
            debtRepaid
        );
    }

    /// @dev Repay debt denominated in Dai, selling it for fyDai. Use before maturity for partial repayments.
    /// @param collateral A Yield Protocol v1 collateral type (WETH/CHAI)
    /// @param pool The pool trading the maturity in which the debt is denominated.
    /// @param user The user owning the Yield Protocol v1 debt vault.
    /// @param debtRepaid The amount of Dai debt that should be repaid, with holdings from this proxy.
    function _repayDebtBeforeMaturity(bytes32 collateral, IPool pool, address user, uint256 debtRepaid) private {
        uint256 maturity = pool.maturity();

        uint256 fyDaiDebtToRepay = pool.sellDai(address(this), address(this), debtRepaid.toUint128());
        controller.repayFYDai(
            collateral,
            maturity,
            address(this),
            user,
            fyDaiDebtToRepay
        );
    }

    /// @dev Repay all debt from an user, buying fyDai. Use before maturity for total repayments.
    /// @param collateral A Yield Protocol v1 collateral type (WETH/CHAI)
    /// @param pool The pool trading the maturity in which the debt is denominated.
    /// @param user The user owning the Yield Protocol v1 debt vault.
    function _repayAllBeforeMaturity(bytes32 collateral, IPool pool, address user) private {
        uint256 maturity = pool.maturity();
        
        // In rollWholeBeforeMaturity we did a preview to make sure we would be buying enough Dai
        uint256 fyDaiDebtToRepay = controller.debtFYDai(collateral, maturity, user);
        pool.buyFYDai(address(this), address(this), fyDaiDebtToRepay.toUint128());
        controller.repayFYDai(
            collateral,
            maturity,
            address(this),
            user,
            fyDaiDebtToRepay
        );
    }

    /// @dev Borrow so that this contract holds a target balance of a given fyDai (matching the one in the pool).
    /// @param collateral A Yield Protocol v1 collateral type (WETH/CHAI)
    /// @param pool The pool trading the maturity in which the debt is denominated.
    /// @param user The user owning the Yield Protocol v1 debt vault.
    /// @param targetFYDai The amount of fyDai that the proxy should hold after executing this function, at a minimum.
    function _borrowToTarget(bytes32 collateral, IPool pool, address user, uint256 targetFYDai) private {
        uint256 fyDaiBalance = pool.fyDai().balanceOf(address(this));
        controller.borrow(
            collateral,
            pool.maturity(),
            user,
            address(this),
            targetFYDai > fyDaiBalance ? targetFYDai - fyDaiBalance : 0 // TODO: Can this be abused?
        );
    }

    /// --------------------------------------------------
    /// Signature method wrappers
    /// --------------------------------------------------

    /// @dev Roll debt from one maturity to another.
    /// @param collateral A Yield Protocol v1 collateral type (WETH/CHAI)
    /// @param pool1 The pool trading the maturity in which the debt is denominated.
    /// @param pool2 The pool trading the maturity in which the debt is being rolled to.
    /// @param user The user owning the Yield Protocol v1 debt vault.
    /// @param daiToBuy The amount of Dai to buy in pool2 to repay debt. Calculate off-chain using daiCostToRepay(collateral, pool1, daiDebtToRepay) or similar.
    /// @param maxFYDaiCost The maximum amount of fyDai debt that will be obtained to secure the new position. Calculate off-chain using pool2.buyDaiPreview(daiDebtToRepay.toUint128()), plus accepted slippage.
    /// @param controllerSig packed signature for delegation of this proxy in the controller. Ignored if '0x'.
    function rollDebtAfterMaturityWithSignature(
        bytes32 collateral,
        IPool pool1,
        IPool pool2,
        address user,
        uint256 daiToBuy,      // Calculate off-chain using daiCostToRepay(collateral, pool1, daiDebtToRepay) or similar
        uint256 maxFYDaiCost,  // Calculate off-chain using pool2.buyDaiPreview(daiDebtToRepay.toUint128()), plus accepted slippage
        bytes memory controllerSig
    ) external {
        if (controllerSig.length > 0) controller.addDelegatePacked(controllerSig);
        return rollDebtAfterMaturity(collateral, pool1, pool2, user, daiToBuy, maxFYDaiCost);
    }

    /// @dev Roll debt from a non-mature series to another
    /// @param collateral A Yield Protocol v1 collateral type (WETH/CHAI)
    /// @param pool1 The pool trading the maturity in which the debt is denominated.
    /// @param pool2 The pool trading the maturity in which the debt is being rolled to.
    /// @param user The user owning the Yield Protocol v1 debt vault.
    /// @param daiToBuy The amount of Dai to buy in pool2 to repay debt. Calculate off-chain using daiCostToRepay(collateral, pool1, daiDebtToRepay) or similar.
    /// @param controllerSig packed signature for delegation of this proxy in the controller. Ignored if '0x'.
    function rollDebtBeforeMaturityWithSignature(
        bytes32 collateral,
        IPool pool1,
        IPool pool2,
        address user,
        uint256 daiToBuy,      // Calculate off-chain using daiCostToRepay(collateral, pool1, daiDebtToRepay) or similar
        uint256 maxFYDaiCost,  // Calculate off-chain using pool2.buyDaiPreview(daiDebtToRepay.toUint128()), plus accepted slippage
        bytes memory controllerSig
    ) external {
        if (controllerSig.length > 0) controller.addDelegatePacked(controllerSig);
        return rollDebtBeforeMaturity(collateral, pool1, pool2, user, daiToBuy, maxFYDaiCost);
    }

    /// @dev Roll all debt from one user and from one mature series to a non-mature series
    /// @param collateral A Yield Protocol v1 collateral type (WETH/CHAI)
    /// @param pool1 The pool trading the maturity in which the debt is denominated.
    /// @param pool2 The pool trading the maturity in which the debt is being rolled to.
    /// @param user The user owning the Yield Protocol v1 debt vault.
    /// @param maxFYDaiCost The maximum amount of fyDai debt that will be obtained to secure the new position. Calculate off-chain using pool2.buyDaiPreview(daiDebtToRepay.toUint128()), plus accepted slippage.
    /// @param controllerSig packed signature for delegation of this proxy in the controller. Ignored if '0x'.
    function rollAllAfterMaturityWithSignature(
        bytes32 collateral,
        IPool pool1,
        IPool pool2,
        address user,
        uint256 maxFYDaiCost,  // Calculate off-chain using pool2.buyDaiPreview(daiDebtToRepay.toUint128()), plus accepted slippage
        bytes memory controllerSig
    ) external {
        if (controllerSig.length > 0) controller.addDelegatePacked(controllerSig);
        return rollAllAfterMaturity(collateral, pool1, pool2, user, maxFYDaiCost);
    }

    /// @dev Roll all debt from one user and from one non-mature series to another non-mature series
    /// @param collateral A Yield Protocol v1 collateral type (WETH/CHAI)
    /// @param pool1 The pool trading the maturity in which the debt is denominated.
    /// @param pool2 The pool trading the maturity in which the debt is being rolled to.
    /// @param user The user owning the Yield Protocol v1 debt vault.
    /// @param maxFYDaiCost The maximum amount of fyDai debt that will be obtained to secure the new position. Calculate off-chain using pool2.buyDaiPreview(daiDebtToRepay.toUint128()), plus accepted slippage.
    /// @param controllerSig packed signature for delegation of this proxy in the controller. Ignored if '0x'.
    function rollAllBeforeMaturityWithSignature(
        bytes32 collateral,
        IPool pool1,
        IPool pool2,
        address user,
        uint256 maxFYDaiCost,  // Calculate off-chain using pool2.buyDaiPreview(daiDebtToRepay.toUint128()), plus accepted slippage
        bytes memory controllerSig
    ) external {
        if (controllerSig.length > 0) controller.addDelegatePacked(controllerSig);
        return rollAllBeforeMaturity(collateral, pool1, pool2, user, maxFYDaiCost);
    }
}