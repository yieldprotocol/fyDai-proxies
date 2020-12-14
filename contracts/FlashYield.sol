// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.10;

import "@openzeppelin/contracts/math/SafeMath.sol";
import "./interfaces/IPool.sol";
import "./interfaces/IFYDai.sol";
import "./helpers/SafeCast.sol";

/**
 * IFlashBorrower receives flash loans of Dai, and is expected to repay them plus a fee.
 * Implements ERC-3156: https://github.com/ethereum/EIPs/blob/master/EIPS/eip-3156.md
 */
interface IFlashBorrower {
    function onFlashLoan(address sender, uint256 loanAmount, uint256 fee, bytes memory data) external;
}

/**
 * FlashYield allows flash loans of Dai out of a YieldSpace pool, by flash minting fyDai and selling it to the pool.
 * Implements ERC-3156: https://github.com/ethereum/EIPs/blob/master/EIPS/eip-3156.md
 */
abstract contract FlashYield is IFlashBorrower {
    using SafeCast for uint256;
    using SafeMath for uint256;

    IPool public pool;

    /// @dev ERC-3156 doesn't have provisions to choose a lender, which is what `setPool` effectively does.
    function setPool(IPool pool_) public {
        pool = pool_;

        // Allow pool to take dai and fyDai for trading
        if (pool.dai().allowance(address(this), address(pool)) < type(uint256).max)
            pool.dai().approve(address(pool), type(uint256).max);
        if (pool.fyDai().allowance(address(this), address(pool)) < type(uint112).max)
            pool.fyDai().approve(address(pool), type(uint256).max);

    }

    /// @dev Fee charged on top of a Dai flash loan.
    function flashFee(uint256 daiAmount) public view returns (uint256) {
        uint128 fyDaiAmount = pool.buyDaiPreview(daiAmount.toUint128());
        return uint256(pool.buyFYDaiPreview(fyDaiAmount)).sub(daiAmount);
    }

    /// @dev Maximum Dai flash loan available.
    function flashSupply() public view returns (uint256) {
        return pool.getDaiReserves();
    }

    /// @dev ERC-3156 entry point to send `daiAmount` Dai to `receiver` as a flash loan.
    function flashLoan(address receiver, uint256 daiAmount, bytes memory data) public returns (uint256) {
        data = abi.encodePacked(data, receiver);   // append receiver to data
        data = abi.encodePacked(data, msg.sender); // append msg.sender to data
        uint256 fyDaiAmount = pool.buyDaiPreview(daiAmount.toUint128());
        pool.fyDai().flashMint(fyDaiAmount, data);
    }

    /// @dev FYDai `flashMint` callback, which bridges to the ERC-3156 `onFlashLoan` callback.
    function executeOnFlashMint(uint256 fyDaiAmount, bytes memory data) public {
        require(msg.sender == address(pool.fyDai()), "Callbacks only allowed from fyDai contract");

        address receiver;
        address sender;
        uint256 length = data.length;
        assembly { 
            receiver := mload(add(data, length))
            sender := mload(add(data, add(length, 20)))
        }

        uint256 daiLoan = pool.sellFYDai(address(this), receiver, fyDaiAmount.toUint128());
        uint256 fee = uint256(pool.buyFYDaiPreview(fyDaiAmount.toUint128())).sub(daiLoan);
        
        IFlashBorrower(receiver).onFlashLoan(sender, daiLoan, fee, data);
    }

    /// @dev Override this function with your own logic. Make sure the contract holds `loanAmount` + `fee` Dai
    // and that `repayFlashLoan` is called.
    function onFlashLoan(address sender, uint256 loanAmount, uint256 fee, bytes memory data) public override virtual {
        repayFlashLoan(loanAmount, fee);
    }

    /// @dev Before the end of the transaction, `receiver` must `transfer` the `loanAmount` plus the `fee`
    /// to this contract and call `repayFlashLoan` to do the conversions that repay the loan.
    function repayFlashLoan(uint256 loanAmount, uint256 fee) public {
        pool.sellDai(address(this), address(this), loanAmount.add(fee).toUint128());
    }
}
