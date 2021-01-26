// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.10;

import "./interfaces/IERC3156FlashBorrower.sol";
import "./interfaces/IERC3156FlashLender.sol";
import "./helpers/DecimalMath.sol";
import "./helpers/SafeCast.sol";
import "./helpers/YieldAuth.sol";
import "./ImportProxyBase.sol";


contract RollProxy is DecimalMath, IERC3156FlashBorrower {
    using SafeCast for uint256;
    using YieldAuth for IController;

    IERC20 public immutable dai;
    IController public immutable controller;
    IProxyRegistry public immutable proxyRegistry;
    IERC3156FlashLender public immutable lender;

    bytes32 public constant WETH = "ETH-A";

    mapping(address => bool) public knownPools;

    constructor(IController controller_, IPool[] memory pools_, IProxyRegistry proxyRegistry_, IERC3156FlashLender lender_)
        public
    {
        ITreasury _treasury = controller_.treasury();
        IERC20 _dai = _treasury.dai();
        
        controller = controller_;
        proxyRegistry = proxyRegistry_;
        lender = _lender;

        // Register pool and allow it to take fyDai for trading
        for (uint i = 0 ; i < pools_.length; i++) {
            pools_[i].fyDai().approve(address(pools_[i]), type(uint256).max);
            knownPools[address(pools_[i])] = true;
        }

        // Allow treasury to take dai for repaying
        _dai.approve(address(_treasury), type(uint256).max);
    }

    /// --------------------------------------------------
    /// RollProxy via dsproxy: Set permissions
    /// --------------------------------------------------

    function rollDebt(
        bytes32 collateral,
        IPool pool1,
        IPool pool2,
        address user,
        uint256 daiAmount,
        uint256 maxDaiCost
    ) public {
        require(user == msg.sender || proxyRegistry.proxies(user) == msg.sender, "Restricted to user or its dsproxy");
        require(knownPools[address(pool1)] && knownPools[address(pool2)], "RollProxy: Only known pools");
        bytes memory data = abi.encode(user, collateral, pool1, pool2, daiAmount);

        uint256 maturity1 = pool1.fyDai().maturity();

        uint256 daiToBorrow = (block.timestamp >= maturity1) ?
            pool.buyFYDaiPreview(controller.debtFYDai(collateral, maturity1, user)) :
            controller.debtDai(collateral, maturity1, user);
        // TODO: Add fees for pool2.sellFYDai(...)
        require(daiToBorrow <= maxDaiCost, "RollProxy: Dai limit exceeded");

        lender.flashLoan(address(rollProxy), address(dai), daiToBorrow, data);
    }

    /// --------------------------------------------------
    /// RollProxy as itself: Do the thing
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
        public returns(bytes32)
    {
        require(msg.sender == lender, "Restricted to known lenders");

        (address user, bytes32 collateral, IPool pool1, IPool pool2, uint256 daiToRepay)
            = abi.decode(data, (address, bytes32, uint256, uint256, IPool));
        require(user == sender || proxyRegistry.proxies(user) == sender, "Restricted to user or its dsproxy"); // Someone initiating the flash loan externally couldn't affect the `user` vault of someone else.
        require(knownPools[address(pool)], "RollProxy: Only known pools");

        uint256 maturity1 = pool1.fyDai().maturity();
        uint256 maturity2 = pool2.fyDai().maturity();

        if (block.timestamp >= maturity1){
            controller.repayDai(collateral, maturity1, address(this), user, amount - fee);
        } else {
            pool1.sellDai(address(this), address(this), amount - fee);
            controller.repayFYDai(collateral, maturity1, address(this), user, controller.inFYDai(collateral, maturity1, amount - fee));
        }
        controller.borrow(collateral, maturity2, user, user, controller.inFYDai(collateral, maturity2, amount));
        pool2.sellFYDai(address(this), address(this), controller.inFYDai(collateral, maturity2, amount));

        // emit Event(); ?
        return keccak256("ERC3156FlashBorrower.onFlashLoan");
    }
}
