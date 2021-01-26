// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.10;

import "erc3156/contracts/interfaces/IERC3156FlashBorrower.sol";
import "erc3156/contracts/interfaces/IERC3156FlashLender.sol";
import "./interfaces/IController.sol";
import "./interfaces/IPool.sol";
import "./interfaces/IProxyRegistry.sol";
import "./helpers/SafeCast.sol";
import "./helpers/YieldAuth.sol";


contract RollProxy is IERC3156FlashBorrower {
    using SafeCast for uint256;
    using YieldAuth for IController;

    IERC20 public immutable dai;
    IController public immutable controller;
    IProxyRegistry public immutable proxyRegistry;
    IERC3156FlashLender public immutable lender;
    IERC3156FlashBorrower public immutable rollProxy;  // This contract has two functions, as itself, and delegatecalled by a dsproxy.

    bytes32 public constant WETH = "ETH-A";

    mapping(address => bool) public knownPools;

    constructor(IController controller_, IPool[] memory pools_, IProxyRegistry proxyRegistry_, IERC3156FlashLender lender_)
        public
    {
        ITreasury _treasury = controller_.treasury();
        IERC20 _dai = dai = _treasury.dai();
        controller = controller_;
        proxyRegistry = proxyRegistry_;
        lender = lender_;
        rollProxy = this;

        // Register pool and allow it to take fyDai for trading
        for (uint i = 0 ; i < pools_.length; i++) {
            pools_[i].fyDai().approve(address(pools_[i]), type(uint256).max);
            knownPools[address(pools_[i])] = true;
        }

        // Allow treasury to take dai for repaying
        _dai.approve(address(_treasury), type(uint256).max);
    }

    /// --------------------------------------------------
    /// RollProxy via dsproxy: Trigger the flash loan
    /// --------------------------------------------------

    function rollDebt(
        bytes32 collateral,
        IPool pool1,
        IPool pool2,
        address user,
        uint256 daiDebtToRepay,
        uint256 minDebtRepaid,
        uint256 maxDaiCost
    ) public {
        require(
            user == msg.sender || proxyRegistry.proxies(user) == msg.sender,
            "RollProxy: Restricted to user or its dsproxy"
        ); // Redundant, I think
        require(
            knownPools[address(pool1)] && knownPools[address(pool2)],
            "RollProxy: Only known pools"
        ); // Redundant, I think
        bytes memory data = abi.encode(user, collateral, pool1, pool2, minDebtRepaid, maxDaiCost);
        lender.flashLoan(rollProxy, address(dai), daiDebtToRepay, data); // <-- Make sure this is pool2 that we are borrowing from
    }

    /// --------------------------------------------------
    /// RollProxy as itself: Roll debt
    /// --------------------------------------------------

    /// @dev Roll debt from one maturity to another
    /// addDelegateWithSignature first
    function onFlashLoan(
        address sender,
        address token,
        uint256 amount,
        uint256 fee,
        bytes calldata data
    )
        public override returns(bytes32)
    {
        require(
            msg.sender == address(lender),
            "RollProxy: Restricted to known lenders"
        );

        (address user, bytes32 collateral, IPool pool1, IPool pool2, uint256 minDebtRepaid, uint256 maxDaiCost)
            = abi.decode(data, (address, bytes32, IPool, IPool, uint256, uint256));
        require(
            user == sender || proxyRegistry.proxies(user) == sender,
            "RollProxy: Restricted to user or its dsproxy"
        ); // Someone initiating the flash loan externally couldn't affect the `user` vault of someone else.

        _sellAndRepay(collateral, pool1, user, amount, minDebtRepaid);
        _borrowAndBuy(collateral, pool2, user, amount + fee, maxDaiCost);

        // emit Event(); ?
        return keccak256("ERC3156FlashBorrower.onFlashLoan");
    }

    /// @dev Repay debt in Dai or in FYDai, depending on whether the fyDai has matured
    function _sellAndRepay(bytes32 collateral, IPool pool, address user, uint256 amount, uint256 minDebtRepaid) private {
        uint256 maturity = pool.fyDai().maturity();

        if (block.timestamp >= maturity){
            controller.repayDai(
                collateral,
                maturity,
                address(this),
                user,
                amount
            );
        } else {
            uint256 fyDaiDebtToRepay = pool.sellDai(address(this), address(this), amount.toUint128());
            require(
                controller.inDai(collateral, maturity, fyDaiDebtToRepay) >= minDebtRepaid,
                "RollProxy: Not enough debt repaid"
            );
            controller.repayFYDai(
                collateral,
                maturity,
                address(this),
                user,
                fyDaiDebtToRepay
            );
        }
    }

    /// @dev Borrow fyDai to buy an exact amount of Dai from a pool.
    function _borrowAndBuy(bytes32 collateral, IPool pool, address user, uint256 amount, uint256 maxDaiCost) private {
        controller.borrow(
            collateral,
            pool.fyDai().maturity(),
            user,
            address(this),
            pool.buyDaiPreview(amount.toUint128())
        );
        require(
            pool.buyDai(address(this), address(this), amount.toUint128()) <= maxDaiCost, // Not needed if merging with ERC3156FYDaiWrapper
            "RollProxy: Too much debt acquired"
        );
    }
}
