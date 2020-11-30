/**
 * This file is a blotter for using yield with the truffle console.
 * Copy and paste sections of code to execute different actions quickly across series
 */

const ethers = require("ethers")

// Instantiate Migrations
// migrations = await Migrations.at("0xd110Cfe9f35c5fDfB069606842744577577f50e5") // Mainnet
migrations = await Migrations.at("0x1A4a542Cd99317f9F1A087a7f073335EC1973325") // Kovan

// Instantiate other contracts
vat = await Vat.at(await migrations.contracts(ethers.utils.formatBytes32String("Vat")))
weth = await WETH9.at(await migrations.contracts(ethers.utils.formatBytes32String("Weth")))
wethJoin = await GemJoin.at(await migrations.contracts(ethers.utils.formatBytes32String("WethJoin")))
dai = await Dai.at(await migrations.contracts(ethers.utils.formatBytes32String("Dai")))
daiJoin = await DaiJoin.at(await migrations.contracts(ethers.utils.formatBytes32String("DaiJoin")))
pot = await Pot.at(await migrations.contracts(ethers.utils.formatBytes32String("Pot")))
chai = await Chai.at(await migrations.contracts(ethers.utils.formatBytes32String("Chai")))
end = await End.at(await migrations.contracts(ethers.utils.formatBytes32String("End")))
fyDai0 = await FYDai.at(await migrations.contracts(ethers.utils.formatBytes32String("fyDai20Oct")))
fyDai1 = await FYDai.at(await migrations.contracts(ethers.utils.formatBytes32String("fyDai20Dec")))
fyDai2 = await FYDai.at(await migrations.contracts(ethers.utils.formatBytes32String("fyDai21Mar")))
fyDai3 = await FYDai.at(await migrations.contracts(ethers.utils.formatBytes32String("fyDai21Jun")))
fyDai4 = await FYDai.at(await migrations.contracts(ethers.utils.formatBytes32String("fyDai21Sep")))
fyDai5 = await FYDai.at(await migrations.contracts(ethers.utils.formatBytes32String("fyDai21Dec")))
treasury = await Treasury.at(await migrations.contracts(ethers.utils.formatBytes32String("Treasury")))
controller = await Controller.at(await migrations.contracts(ethers.utils.formatBytes32String("Controller")))
liquidations = await Liquidations.at(await migrations.contracts(ethers.utils.formatBytes32String("Liquidations")))
unwind = await Unwind.at(await migrations.contracts(ethers.utils.formatBytes32String("Unwind")))
pool0 = await Pool.at(await migrations.contracts(ethers.utils.formatBytes32String("fyDaiLP20Oct")))
pool1 = await Pool.at(await migrations.contracts(ethers.utils.formatBytes32String("fyDaiLP20Dec")))
pool2 = await Pool.at(await migrations.contracts(ethers.utils.formatBytes32String("fyDaiLP21Mar")))
pool3 = await Pool.at(await migrations.contracts(ethers.utils.formatBytes32String("fyDaiLP21Jun")))
pool4 = await Pool.at(await migrations.contracts(ethers.utils.formatBytes32String("fyDaiLP21Sep")))
pool5 = await Pool.at(await migrations.contracts(ethers.utils.formatBytes32String("fyDaiLP21Dec")))
// proxy = await YieldProxy.at(await migrations.contracts(ethers.utils.formatBytes32String("YieldProxy"))) // v1 in mainnet, v2 in Kovan
// proxy = await YieldProxy.at("0x5cd6b40763f0d79cd2198425c42efc7ae5b18bc7") // v2 - Mainnet
// proxy = await YieldProxy.at("0xF355ea28308Fe6A6D5Ade775bBFFAe47579C6860") // v2 - Kovan
// poolProxy = await PoolProxy.at("0x8BD14757F1A3e11c57987A5D259fB41d029d1fcA") // poolProxy - Kovan
borrowProxy = await BorrowProxy.at(await migrations.contracts(ethers.utils.formatBytes32String("BorrowProxy")))
poolProxy = await PoolProxy.at(await migrations.contracts(ethers.utils.formatBytes32String("PoolProxy")))
exportProxy = await ExportProxy.at(await migrations.contracts(ethers.utils.formatBytes32String("ExportProxy")))
importProxy = await ImportProxy.at(await migrations.contracts(ethers.utils.formatBytes32String("ImportProxy")))
proxyRegistry = await ProxyRegistry.at(await migrations.contracts(ethers.utils.formatBytes32String("ProxyRegistry")))
console.log("Contracts sourced")

// Constants
RAY = "000000000000000000000000000"
WAD = "000000000000000000"
FIN = "000000000000000"
THOUSAND = "000"
MILLION = "000000"
BILLION = "000000000"
price = "300" + RAY
MAX = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
Line = ethers.utils.formatBytes32String("Line")
line = ethers.utils.formatBytes32String("line")
spot = ethers.utils.formatBytes32String("spot")
ETH_A = ethers.utils.formatBytes32String("ETH-A")
CHAI = ethers.utils.formatBytes32String("CHAI")

accounts = await web3.eth.getAccounts()
me = accounts[0]
allan = "0xc4f8dFd99ef6B88FE81413076140eC30f72Fc83a"
bruce = "0xcd16CA1398DA7b8f072eCF0028A3f4677B19fcd0"
georgios = "0x727060BcA718EE836ddA4cb5be59369844B61DAA"

// Maturities
maturity0 = await fyDai0.maturity()
maturity1 = await fyDai1.maturity()
maturity2 = await fyDai2.maturity()
maturity3 = await fyDai3.maturity()
maturity4 = await fyDai4.maturity()
maturity5 = await fyDai5.maturity()

// Approvals
await vat.rely(allan)
await vat.rely(bruce)
await vat.rely(georgios)
await vat.hope(daiJoin.address)
await vat.hope(proxy.address)
await weth.approve(treasury.address, MAX)
await weth.approve(wethJoin.address, MAX)
await dai.approve(chai.address, MAX)
await dai.approve(treasury.address, MAX)
await dai.approve(pool0.address, MAX)
await dai.approve(pool1.address, MAX)
await dai.approve(pool2.address, MAX)
await dai.approve(pool3.address, MAX)
await dai.approve(pool4.address, MAX)
await dai.approve(pool5.address, MAX)
await dai.approve(proxy.address, MAX)
await chai.approve(treasury.address, MAX)
await fyDai0.approve(treasury.address, MAX)
await fyDai1.approve(treasury.address, MAX)
await fyDai2.approve(treasury.address, MAX)
await fyDai3.approve(treasury.address, MAX)
await fyDai4.approve(treasury.address, MAX)
await fyDai5.approve(treasury.address, MAX)
await fyDai0.approve(pool0.address, MAX)
await fyDai1.approve(pool1.address, MAX)
await fyDai2.approve(pool2.address, MAX)
await fyDai3.approve(pool3.address, MAX)
await fyDai4.approve(pool4.address, MAX)
await fyDai5.approve(pool5.address, MAX)

await dai.approve(pool0.address, MAX, { gas: '0x186A0', gasPrice: '0x104C533C00' })
await dai.approve(pool1.address, MAX, { gas: '0x186A0', gasPrice: '0x104C533C00' })
await dai.approve(pool2.address, MAX, { gas: '0x186A0', gasPrice: '0x104C533C00' })
await dai.approve(pool3.address, MAX, { gas: '0x186A0', gasPrice: '0x104C533C00' })
await dai.approve(pool4.address, MAX, { gas: '0x186A0', gasPrice: '0x104C533C00' })
await dai.approve(pool5.address, MAX, { gas: '0x186A0', gasPrice: '0x104C533C00' })

// DSProxy
await proxyRegistry.build()
dsproxy = await DSProxy.at(await proxyRegistry.proxies(me))

await dai.approve(dsproxy.address, MAX)
await controller.addDelegate(dsproxy.address)
await pool1.addDelegate(dsproxy.address)

calldata = poolProxy.contract.methods.addLiquidity(pool1.address, '1'+WAD, MAX).encodeABI()
await dsproxy.methods['execute(address,bytes)'](poolProxy.address, calldata)

// Add delegates
await controller.addDelegate(proxy.address)
await pool0.addDelegate(proxy.address)
await pool1.addDelegate(proxy.address)
await pool2.addDelegate(proxy.address)
await pool3.addDelegate(proxy.address)
await pool4.addDelegate(proxy.address)
await pool5.addDelegate(proxy.address)

// Obtain Weth    
await weth.deposit({ value: "100" + FIN })

// Obtain Dai
await wethJoin.join(me, "34" + WAD)
await vat.frob(ETH_A, me, me, me, "34" + WAD, "10000" + WAD)
await daiJoin.exit(me, "10000" + WAD)

// Obtain chai
await chai.join(me, "125" + WAD)

// Distribute dai
await dai.transfer(allan, "3" + THOUSAND + WAD)
await dai.transfer(bruce, "3" + THOUSAND + WAD)
await dai.transfer(georgios, "3" + THOUSAND + WAD)

// Borrow
await controller.post(ETH_A, me, me, "100" + FIN)
await controller.post(CHAI, me, me, "125" + WAD)
await controller.borrow(ETH_A, maturity0, me, proxy.address, "10" + FIN)
await controller.borrow(ETH_A, maturity1, me, proxy.address, "10" + FIN)
await controller.borrow(ETH_A, maturity2, me, proxy.address, "10" + FIN)
await controller.borrow(ETH_A, maturity3, me, proxy.address, "10" + FIN)
await controller.borrow(ETH_A, maturity4, me, proxy.address, "10" + FIN)
await controller.borrow(ETH_A, maturity5, me, proxy.address, "10" + FIN)
await controller.borrow(CHAI, maturity1, me, me, "25" + WAD)
await controller.borrow(CHAI, maturity2, me, me, "25" + WAD)
await controller.borrow(CHAI, maturity3, me, me, "25" + WAD)
await controller.borrow(CHAI, maturity4, me, me, "25" + WAD)

// Add liquidity
await proxy.addLiquidity(pool0.address, "100" + WAD, MAX)
await proxy.addLiquidity(pool1.address, "100" + WAD, MAX)
await proxy.addLiquidity(pool2.address, "100" + WAD, MAX)
await proxy.addLiquidity(pool3.address, "100" + WAD, MAX)
await proxy.addLiquidity(pool4.address, "100" + WAD, MAX)

// Buy and sell
await proxy.sellFYDai(pool0.address, me, tokensToAdd(maturity0, rate, await pool0.getDaiReserves()).toString() + WAD, 0)
await proxy.sellFYDai(pool1.address, me, "20" + WAD, 0)
await proxy.sellFYDai(pool2.address, me, "20" + WAD, 0)
await proxy.sellFYDai(pool3.address, me, "20" + WAD, 0)
await proxy.sellFYDai(pool4.address, me, "20" + WAD, 0)

await proxy.sellDai(pool0.address, me, "10" + WAD, 0)
await proxy.sellDai(pool1.address, me, "10" + WAD, 0)
await proxy.sellDai(pool2.address, me, "10" + WAD, 0)
await proxy.sellDai(pool3.address, me, "10" + WAD, 0)
await proxy.sellDai(pool4.address, me, "10" + WAD, 0)

await proxy.buyFYDai(pool0.address, me, "10" + WAD, MAX)
await proxy.buyFYDai(pool1.address, me, "10" + WAD, MAX)
await proxy.buyFYDai(pool2.address, me, "10" + WAD, MAX)
await proxy.buyFYDai(pool3.address, me, "10" + WAD, MAX)
await proxy.buyFYDai(pool4.address, me, "10" + WAD, MAX)

await proxy.buyDai(pool0.address, me, "10" + WAD, MAX)
await proxy.buyDai(pool1.address, me, "10" + WAD, MAX)
await proxy.buyDai(pool2.address, me, "10" + WAD, MAX)
await proxy.buyDai(pool3.address, me, "10" + WAD, MAX)
await proxy.buyDai(pool4.address, me, "10" + WAD, MAX)

// Repay
(await dai.balanceOf(me)).toString()
(await fyDai0.balanceOf(me)).toString()
(await fyDai1.balanceOf(me)).toString()
(await fyDai2.balanceOf(me)).toString()
(await fyDai3.balanceOf(me)).toString()
(await fyDai4.balanceOf(me)).toString()
(await fyDai5.balanceOf(me)).toString()

(await controller.debtFYDai(ETH_A, maturity0, me)).toString()
(await controller.debtFYDai(ETH_A, maturity1, me)).toString()
(await controller.debtFYDai(ETH_A, maturity2, me)).toString()
(await controller.debtFYDai(ETH_A, maturity3, me)).toString()
(await controller.debtFYDai(ETH_A, maturity4, me)).toString()
(await controller.debtFYDai(ETH_A, maturity5, me)).toString()
(await controller.locked(ETH_A, me)).toString()

(await controller.debtDai(ETH_A, maturity0, me)).toString()
(await controller.debtDai(ETH_A, maturity1, me)).toString()
(await controller.debtDai(ETH_A, maturity2, me)).toString()
(await controller.debtDai(ETH_A, maturity3, me)).toString()
(await controller.debtDai(ETH_A, maturity4, me)).toString()

(await controller.debtFYDai(CHAI, maturity0, me)).toString()
(await controller.debtFYDai(CHAI, maturity1, me)).toString()
(await controller.debtFYDai(CHAI, maturity2, me)).toString()
(await controller.debtFYDai(CHAI, maturity3, me)).toString()
(await controller.debtFYDai(CHAI, maturity4, me)).toString()
(await controller.locked(CHAI, me)).toString()

(await controller.debtDai(CHAI, maturity0, me)).toString()
(await controller.debtDai(CHAI, maturity1, me)).toString()
(await controller.debtDai(CHAI, maturity2, me)).toString()
(await controller.debtDai(CHAI, maturity3, me)).toString()
(await controller.debtDai(CHAI, maturity4, me)).toString()

(await controller.repayDai(ETH_A, maturity0, me, me, "25" + WAD))
(await controller.repayDai(ETH_A, maturity1, me, me, "25" + WAD))
(await controller.repayDai(ETH_A, maturity2, me, me, "25" + WAD))
(await controller.repayDai(ETH_A, maturity3, me, me, "25" + WAD))
(await controller.repayDai(ETH_A, maturity4, me, me, "25" + WAD))

(await controller.repayFYDai(ETH_A, maturity0, me, me, '111111111111111111111'))
(await controller.repayFYDai(ETH_A, maturity1, me, me, '111111111111111111111'))
(await controller.repayFYDai(ETH_A, maturity2, me, me, '111111111111111111111'))
(await controller.repayFYDai(ETH_A, maturity3, me, me, '111111111111111111111'))
(await controller.repayFYDai(ETH_A, maturity4, me, me, '111111111111111111111'))
(await controller.repayFYDai(ETH_A, maturity5, me, me, '111111111111111111111'))

(await controller.repayDai(CHAI, maturity0, me, me, "25" + WAD))
(await controller.repayDai(CHAI, maturity1, me, me, "25" + WAD))
(await controller.repayDai(CHAI, maturity2, me, me, "25" + WAD))
(await controller.repayDai(CHAI, maturity3, me, me, "25" + WAD))
(await controller.repayDai(CHAI, maturity4, me, me, "25" + WAD))

(await controller.repayFYDai(CHAI, maturity0, me, me, "25" + WAD))
(await controller.repayFYDai(CHAI, maturity1, me, me, "25" + WAD))
(await controller.repayFYDai(CHAI, maturity2, me, me, "25" + WAD))
(await controller.repayFYDai(CHAI, maturity3, me, me, "25" + WAD))
(await controller.repayFYDai(CHAI, maturity4, me, me, "25" + WAD))

// Redeem
await fyDai0.redeem(me, me, "1" + WAD)
await fyDai1.redeem(me, me, "1" + WAD)
await fyDai2.redeem(me, me, "1" + WAD)
await fyDai3.redeem(me, me, "1" + WAD)
await fyDai4.redeem(me, me, "1" + WAD)

// Fix proxy for rounding
await fyDai0.transfer(proxy.address, "10" + FIN)
await fyDai1.transfer(proxy.address, "10" + FIN)
await fyDai2.transfer(proxy.address, "10" + FIN)
await fyDai3.transfer(proxy.address, "10" + FIN)
await fyDai4.transfer(proxy.address, "10" + FIN)
await fyDai5.transfer(proxy.address, "10" + FIN)


// Withdraw
(await controller.withdraw(ETH_A, me, me, "500" + FIN))
(await controller.withdraw(CHAI, me, me, "1000" + WAD))

// Remove liquidity
(await pool0.balanceOf(me)).toString()
(await pool1.balanceOf(me)).toString()
(await pool2.balanceOf(me)).toString()
(await pool3.balanceOf(me)).toString()
(await pool4.balanceOf(me)).toString()
(await pool5.balanceOf(me)).toString()

(await pool0.totalSupply()).toString()
(await pool1.totalSupply()).toString()
(await pool2.totalSupply()).toString()
(await pool3.totalSupply()).toString()
(await pool4.totalSupply()).toString()
(await pool5.totalSupply()).toString()

(await fyDai0.totalSupply()).toString()
(await fyDai1.totalSupply()).toString()
(await fyDai2.totalSupply()).toString()
(await fyDai3.totalSupply()).toString()
(await fyDai4.totalSupply()).toString()
(await fyDai5.totalSupply()).toString()

(await dai.totalSupply()).toString()
(await weth.totalSupply()).toString()

await proxy.removeLiquidityEarlyDaiFixed(pool0.address, '1000' + WAD, 0)
await proxy.removeLiquidityEarlyDaiFixed(pool1.address, '1000' + WAD, 0)
await proxy.removeLiquidityEarlyDaiFixed(pool2.address, '1000' + WAD, 0)
await proxy.removeLiquidityEarlyDaiFixed(pool3.address, '1000' + WAD, 0)
await proxy.removeLiquidityEarlyDaiFixed(pool4.address, '1000' + WAD, 0)
await proxy.removeLiquidityEarlyDaiFixed(pool5.address, '1000' + WAD, 0)

await pool0.mint(me, me, "5" + WAD, { gas: '0x61A80', gasPrice: '0x104C533C00' })
await pool1.mint(me, me, "4" + WAD, { gas: '0x61A80', gasPrice: '0x104C533C00' })
await pool2.mint(me, me, "4" + WAD, { gas: '0x61A80', gasPrice: '0x104C533C00' })
await pool3.mint(me, me, "4" + WAD, { gas: '0x61A80', gasPrice: '0x104C533C00' })
await pool4.mint(me, me, "4" + WAD, { gas: '0x61A80', gasPrice: '0x104C533C00' })
await pool5.mint(me, me, "4" + WAD, { gas: '0x61A80', gasPrice: '0x104C533C00' })

await pool0.burn(me, me, "1000" + WAD)
await pool1.burn(me, me, "1000" + WAD)
await pool2.burn(me, me, "1000" + WAD)
await pool3.burn(me, me, "1000" + WAD)
await pool4.burn(me, me, "1000" + WAD)
await pool5.burn(me, me, "1000" + WAD)

(await fyDai0.balanceOf(proxy.address)).toString()
(await fyDai1.balanceOf(proxy.address)).toString()
(await fyDai2.balanceOf(proxy.address)).toString()
(await fyDai3.balanceOf(proxy.address)).toString()
(await fyDai4.balanceOf(proxy.address)).toString()
(await fyDai5.balanceOf(proxy.address)).toString()

// Splitter
await proxy.yieldToMaker(pool3.address, me, '600' + FIN, '25' + WAD, { from: me })
await proxy.makerToYield(pool3.address, me, '500' + FIN, '24' + WAD, { from: me })

// Unwind
await end.cage()
tag = '3333333333333333333333333'
await end.setTag(ETH_A, tag)

await end.setDebt(1)

fix = '3030303030303030303030303'
await end.setFix(ETH_A, fix)

await end.skim(ETH_A, me)

await unwind.unwind()

await unwind.settleTreasury()

await unwind.cashSavings()


(await weth.balanceOf(me)).toString()
(await weth.balanceOf(unwind.address)).toString()

await unwind.settle(ETH_A, me)
await unwind.settle(CHAI, me)
await unwind.redeem(maturity0, me)
await unwind.redeem(maturity1, me)
await unwind.redeem(maturity2, me)
await unwind.redeem(maturity3, me)
await unwind.redeem(maturity4, me)

(await weth.balanceOf(me)).toString()
(await weth.balanceOf(unwind.address)).toString()
