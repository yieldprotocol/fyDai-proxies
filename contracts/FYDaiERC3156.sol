// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.10;

import "./interfaces/IFYDai.sol";

/**
 * IFlashBorrower receives flash loans, and is expected to repay them plus a fee.
 * Implements ERC-3156: https://github.com/ethereum/EIPs/blob/master/EIPS/eip-3156.md
 */
interface IFlashBorrower {
    function onFlashLoan(address sender, uint256 loanAmount, uint256 fee, bytes memory data) external;
}

/**
 * FYDaiERC3156 allows flash loans of fyDai out of a YieldSpace pool, by flash minting fyDai and selling it to the pool.
 * Implements ERC-3156: https://github.com/ethereum/EIPs/blob/master/EIPS/eip-3156.md
 */
contract FYDaiERC3156 {
    IFYDai public fyDai;

    constructor (IFYDai fyDai_) public {
        fyDai = fyDai_;
    }

    /// @dev Fee charged on top of a fyDai flash loan.
    function flashFee(uint256) public view returns (uint256) {
        return 0;
    }

    /// @dev Maximum fyDai flash loan available.
    function flashSupply() public view returns (uint256) {
        return type(uint112).max - fyDai.totalSupply(); // Can't overflow
    }

    /// @dev ERC-3156 entry point to send `fyDaiAmount` fyDai to `receiver` as a flash loan.
    function flashLoan(address receiver, uint256 fyDaiAmount, bytes memory data) public returns (uint256) {
        data = abi.encodePacked(data, receiver);   // append receiver to data
        data = abi.encodePacked(data, msg.sender); // append msg.sender to data
        fyDai.flashMint(fyDaiAmount, data);
    }

    /// @dev FYDai `flashMint` callback, which bridges to the ERC-3156 `onFlashLoan` callback.
    function executeOnFlashMint(uint256 fyDaiAmount, bytes memory data) public {
        require(msg.sender == address(fyDai), "Callbacks only allowed from fyDai contract");

        address receiver;
        address sender;
        uint256 length = data.length;
        assembly { 
            receiver := mload(add(data, length))
            sender := mload(add(data, add(length, 20)))
        }
        
        IFlashBorrower(receiver).onFlashLoan(sender, fyDaiAmount, 0, data);
    }
}
