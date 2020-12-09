// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.10;


/// @dev interface for the DssCdpManager contract from MakerDAO
interface ICDPMgr {
    function owns(uint cdp) view external returns(address);
    function urns(uint cdp) view external returns(address);
    function cdpCan(address owns, uint cdp, address usr) view external returns(uint256);
    function give(uint cdp, address usr) external;
    function frob(uint cdp, int dink, int dart) external;

}