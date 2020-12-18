// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.10;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./interfaces/IController.sol";
import "./interfaces/IWeth.sol";
import "./interfaces/IGemJoin.sol";
import "./interfaces/IDaiJoin.sol";
import "./interfaces/IVat.sol";
import "./interfaces/IPool.sol";
import "./interfaces/IFYDai.sol";


interface IProxyRegistry {
    function proxies(address) external view returns (address);
}

contract ImportProxyBase {

    event ImportedFromMaker(uint256 indexed maturity, address indexed from, address indexed to, uint256 wethAmount, uint256 daiAmount);

    IVat public immutable vat;
    IWeth public immutable weth;
    IERC20 public immutable dai;
    IGemJoin public immutable wethJoin;
    IDaiJoin public immutable daiJoin;
    IController public immutable controller;
    IProxyRegistry public immutable proxyRegistry;

    bytes32 public constant WETH = "ETH-A";

    constructor(IController controller_, IPool[] memory pools_, IProxyRegistry proxyRegistry_) public {
        ITreasury _treasury = controller_.treasury();

        IVat _vat = _treasury.vat();
        IWeth _weth = _treasury.weth();
        IERC20 _dai = _treasury.dai();
        address _daiJoin = address(_treasury.daiJoin());
        address _wethJoin = address(_treasury.wethJoin());
        
        controller = controller_;
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
}
