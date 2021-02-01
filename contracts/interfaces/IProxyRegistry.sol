// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.10;


interface IProxyRegistry {
    function proxies(address) external view returns (address);
}