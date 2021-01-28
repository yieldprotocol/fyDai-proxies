const DSProxyFactory = artifacts.require('DSProxyFactory')
const DSProxyRegistry = artifacts.require('ProxyRegistry')
const RollProxy = artifacts.require('RollProxy')

import { WETH, spot, wethTokens1, toWad, toRay, mulRay, bnify, MAX } from './shared/utils'
import { MakerEnvironment, YieldEnvironmentLite, YieldSpace, Contract } from './shared/fixtures'

// @ts-ignore
import { balance, BN, expectRevert } from '@openzeppelin/test-helpers'
import { assert, expect } from 'chai'

contract('RollProxy', async (accounts) => {
  let [owner, user1, user2] = accounts

  let maker: MakerEnvironment
  let protocol: YieldEnvironmentLite
  let yieldSpace: YieldSpace
  let controller: Contract
  let treasury: Contract
  let weth: Contract
  let dai: Contract
  let vat: Contract
  let fyDai1: Contract
  let fyDai2: Contract
  let pool1: Contract
  let pool2: Contract
  let proxyFactory: Contract
  let proxyRegistry: Contract
  let rollProxy: Contract

  let maturity1: number
  let maturity2: number

  beforeEach(async () => {
    const timestamp = (await web3.eth.getBlock(await web3.eth.getBlockNumber())).timestamp
    maturity1 = timestamp + 31556952 // One year
    maturity2 = timestamp + 63113904 // Two years
    protocol = await YieldEnvironmentLite.setup([maturity1, maturity2])
    yieldSpace = await YieldSpace.setup(protocol)

    maker = protocol.maker
    weth = maker.weth
    dai = maker.dai
    vat = maker.vat
    controller = protocol.controller
    treasury = protocol.treasury
    fyDai1 = protocol.fyDais[0]
    fyDai2 = protocol.fyDais[1]
    pool1 = yieldSpace.pools[0]
    pool2 = yieldSpace.pools[1]
    await yieldSpace.initPool(pool1, toWad(1000), owner)
    await yieldSpace.initPool(pool2, toWad(1000), owner)

    // Setup DSProxyFactory and DSProxyCache
    proxyFactory = await DSProxyFactory.new({ from: owner })

    // Setup DSProxyRegistry
    proxyRegistry = await DSProxyRegistry.new(proxyFactory.address, { from: owner })

    // Setup RollProxy
    rollProxy = await RollProxy.new(controller.address, [pool1.address, pool2.address], proxyRegistry.address, { from: owner })

    await protocol.postWeth(user1, toWad(10))
    await controller.borrow(WETH, maturity1, user1, user1, toWad(100), { from: user1 })

    await controller.addDelegate(rollProxy.address, { from: user1 })
  })

  it('rolls debt', async () => {
    await rollProxy.rollDebt(
      WETH,
      pool1.address,
      pool2.address,
      user1,
      toWad(10),
      0,
      toWad(100),
      { from: user1 }
    )
    console.log((await controller.debtDai(WETH, maturity1, user1)).toString())
    console.log((await controller.debtDai(WETH, maturity2, user1)).toString())
  })
})
