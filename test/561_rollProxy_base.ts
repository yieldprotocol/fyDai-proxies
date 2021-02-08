const DSProxyFactory = artifacts.require('DSProxyFactory')
const DSProxyRegistry = artifacts.require('ProxyRegistry')
const RollProxy = artifacts.require('RollProxy')

// @ts-ignore
import helper from 'ganache-time-traveler'
import { WETH, toWad, name, chainId, MAX } from './shared/utils'
import { MakerEnvironment, YieldEnvironmentLite, YieldSpace, Contract } from './shared/fixtures'
import { getSignatureDigest, userPrivateKey, sign } from './shared/signatures'

async function currentTimestamp(): BN {
  const block = await web3.eth.getBlockNumber()
  return new BN((await web3.eth.getBlock(block)).timestamp.toString())
}

function toBigNumber(x: any) {
  if (typeof x == 'object') x = x.toString()
  if (typeof x == 'number') return new BN(x)
  else if (typeof x == 'string') {
    if (x.startsWith('0x') || x.startsWith('0X')) return new BN(x.substring(2), 16)
    else return new BN(x)
  }
}

function almostEqual(x: any, y: any, p: any) {
  // Check that abs(x - y) < p:
  const xb = toBigNumber(x)
  const yb = toBigNumber(y)
  const pb = toBigNumber(p)
  const diff = xb.gt(yb) ? xb.sub(yb) : yb.sub(xb)
  expect(diff).to.be.bignumber.lt(pb)
}

// @ts-ignore
import { balance, BN, expectRevert } from '@openzeppelin/test-helpers'
import { assert, expect } from 'chai'

contract('RollProxy', async (accounts) => {
  let snapshot: any
  let snapshotId: string

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
    snapshot = await helper.takeSnapshot()
    snapshotId = snapshot['result']

    maturity1 = (await currentTimestamp()).addn(31556952) // One year
    maturity2 = (await currentTimestamp()).addn(63113904) // Two years
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

  afterEach(async () => {
    await helper.revertToSnapshot(snapshotId)
  })

  it('rolls debt before maturity', async () => {
    const debtToRoll = new BN(toWad(10).toString())
    const daiToBuy = await rollProxy.daiCostToRepay(WETH, pool1.address, debtToRoll)
    const maxFYDaiCost = new BN(toWad(100).toString())
    const daiDebtBefore = await controller.debtDai(WETH, maturity1, user1)

    /*
    const daiToPay = buyFYDai(
      (await pool1.getDaiReserves()).toString(),
      (await pool1.getFYDaiReserves()).toString(),
      (await controller.inFYDai(WETH, maturity1, debtToRoll)).toString(), // Convert `debtToRoll` to fyDai1, and then buy it
      (new BN(maturity1)).sub(await currentTimestamp()).toString(),
    )
    const debtInFYDai2 = await controller.inFYDai(WETH, maturity2, floor(daiToPay).toFixed().toString()) // We borrow `daiToPay` worth of fyDai2
    */

    // Then borrow fyDai2Used to make the flash loan whole

    await rollProxy.rollDebtBeforeMaturity(
      WETH,
      pool1.address,
      pool2.address,
      user1,
      daiToBuy,
      maxFYDaiCost,
      { from: user1 }
    )
    // Assert Dai debt of maturity 1 decreased by `debtToRoll`
    almostEqual(
      await controller.debtDai(WETH, maturity1, user1),
      daiDebtBefore.sub(debtToRoll),
      debtToRoll.divn(100000)
    )
    // Calculate how much fyDai2 debt is that equivalent to.
    /* almostEqual(
      await controller.debtFYDai(WETH, maturity2, user1),
      debtInFYDai2.toString(),
      debtToRoll.divn(100000)
    ) */
    // At least, make sure the proxy keeps nothing
    assert.equal((await dai.balanceOf(rollProxy.address)).toString(), '0')
    assert.equal((await fyDai1.balanceOf(rollProxy.address)).toString(), '0')
    assert.equal((await fyDai2.balanceOf(rollProxy.address)).toString(), '0')
  })

  it('rolls debt after maturity', async () => {
    await helper.advanceTime(31556952)
    await helper.advanceBlock()
    await fyDai1.mature()

    const debtToRoll = new BN(toWad(10).toString())
    const daiToBuy = await rollProxy.daiCostToRepay(WETH, pool1.address, debtToRoll)
    const maxFYDaiCost = new BN(toWad(100).toString())    
    const daiDebtBefore = await controller.debtDai(WETH, maturity1, user1)

    /*
    const daiToPay = buyFYDai(
      (await pool1.getDaiReserves()).toString(),
      (await pool1.getFYDaiReserves()).toString(),
      (await controller.inFYDai(WETH, maturity1, debtToRoll)).toString(), // Convert `debtToRoll` to fyDai1, and then buy it
      (new BN(maturity1)).sub(await currentTimestamp()).toString(),
    )
    const debtInFYDai2 = await controller.inFYDai(WETH, maturity2, floor(daiToPay).toFixed().toString()) // We borrow `daiToPay` worth of fyDai2
    */

    // Then borrow fyDai2Used to make the flash loan whole

    await rollProxy.rollDebtAfterMaturity(
      WETH,
      pool1.address,
      pool2.address,
      user1,
      daiToBuy,
      maxFYDaiCost,
      { from: user1 }
    )
    // Assert Dai debt of maturity 1 decreased by `debtToRoll`
    almostEqual(
      await controller.debtDai(WETH, maturity1, user1),
      daiDebtBefore.sub(debtToRoll),
      debtToRoll.divn(100000)
    )
    // Calculate how much fyDai2 debt is that equivalent to.
    /* almostEqual(
      await controller.debtFYDai(WETH, maturity2, user1),
      debtInFYDai2.toString(),
      debtToRoll.divn(100000)
    ) */
    // At least, make sure the proxy keeps nothing
    assert.equal((await dai.balanceOf(rollProxy.address)).toString(), '0')
    assert.equal((await fyDai1.balanceOf(rollProxy.address)).toString(), '0')
    assert.equal((await fyDai2.balanceOf(rollProxy.address)).toString(), '0')
  })

  it('rolls debt with signature', async () => {
    await controller.revokeDelegate(rollProxy.address, { from: user1 })
    const debtToRoll = new BN(toWad(10).toString())
    const daiToBuy = await rollProxy.daiCostToRepay(WETH, pool1.address, debtToRoll)
    const maxFYDaiCost = new BN(toWad(100).toString())    

    // Authorize the proxy for the controller
    const controllerDigest = getSignatureDigest(
      name,
      controller.address,
      chainId,
      {
        user: user1,
        delegate: rollProxy.address,
      },
      (await controller.signatureCount(user1)).toString(),
      MAX
    )
    const controllerSig = sign(controllerDigest, userPrivateKey)

    await rollProxy.rollDebtBeforeMaturityWithSignature(
      WETH,
      pool1.address,
      pool2.address,
      user1,
      daiToBuy,
      maxFYDaiCost,
      controllerSig,
      { from: user1 }
    )
  })

  it('Reverts if the cost in fyDai2 is too large', async () => {
    const debtToRoll = new BN(toWad(10).toString())

    await expectRevert(
      rollProxy.rollDebtBeforeMaturity(
        WETH,
        pool1.address,
        pool2.address,
        user1,
        debtToRoll,
        0,
        { from: user1 }
      ),
      "ERC20: transfer amount exceeds balance"
    )
  })
})
