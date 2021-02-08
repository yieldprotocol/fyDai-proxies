const Pool = artifacts.require('Pool')
const PoolProxy = artifacts.require('PoolProxy')

// @ts-ignore
import helper from 'ganache-time-traveler'
import {
  WETH,
  CHAI,
  chi1,
  rate1,
  daiTokens1,
  chaiTokens1,
  toWad,
  toRay,
  divrup,
  precision,
  bnify,
  ZERO,
  MAX,
  functionSignature,
} from './shared/utils'
import { fyDaiForMint } from './shared/fyDaiForMint'
import { MakerEnvironment, YieldEnvironmentLite, Contract } from './shared/fixtures'
// @ts-ignore
import { BN, expectRevert } from '@openzeppelin/test-helpers'
import { assert, expect } from 'chai'
import { BigNumber } from 'ethers'

contract('PoolProxy', async (accounts) => {
  let [owner, user1, user2, user3, user4, user5, user6, user7, user8, user9] = accounts

  const initialDai = daiTokens1

  let snapshot: any
  let snapshotId: string

  let maker: MakerEnvironment
  let env: YieldEnvironmentLite
  let treasury: Contract
  let controller: Contract

  let weth: Contract
  let dai: Contract
  let chai: Contract
  let pool0: Contract
  let fyDai0: Contract
  let pool1: Contract
  let fyDai1: Contract
  let pool2: Contract
  let fyDai2: Contract
  let proxy: Contract

  let maturity0: number
  let maturity1: number
  let maturity2: number

  const roundingProfit: any = new BN('100') // Some wei remain in proxy with each operation due to rounding

  const daiInForMint = (daiReserves: BigNumber, fyDaiReserves: BigNumber, daiUsed: BigNumber): BigNumber => {
    return daiUsed.mul(daiReserves).div(daiReserves.add(fyDaiReserves))
  }

  const fyDaiInForMint = (daiReserves: BigNumber, fyDaiReserves: BigNumber, daiUsed: BigNumber): BigNumber => {
    return daiUsed.mul(fyDaiReserves).div(daiReserves.add(fyDaiReserves))
  }

  const postedIn = (expectedDebt: BigNumber, chi: BigNumber): BigNumber => {
    return divrup(expectedDebt.mul(toRay(1)), bnify(chi))
  }

  const mintedOut = (poolSupply: BigNumber, daiInForMint: BigNumber, daiReserves: BigNumber): BigNumber => {
    return poolSupply.mul(daiInForMint).div(daiReserves)
  }

  function almostEqual(x: BigNumber, y: BigNumber, p: BigNumber) {
    // Check that abs(x - y) < p:
    const diff = x.gt(y) ? x.sub(y) : y.sub(x)
    expect(diff.toString()).to.be.bignumber.lt(new BN(p.toString()))
  }

  beforeEach(async () => {
    snapshot = await helper.takeSnapshot()
    snapshotId = snapshot['result']

    // Setup fyDai
    const block = await web3.eth.getBlockNumber()
    maturity0 = (await web3.eth.getBlock(block)).timestamp + 15778476 // Six months
    maturity1 = (await web3.eth.getBlock(block)).timestamp + 31556952 // One year
    maturity2 = (await web3.eth.getBlock(block)).timestamp + 63113904 // Two years

    env = await YieldEnvironmentLite.setup([maturity0, maturity1, maturity2])
    maker = env.maker
    weth = env.maker.weth
    dai = env.maker.dai
    chai = env.maker.chai
    treasury = env.treasury
    controller = env.controller
    fyDai0 = env.fyDais[0]
    fyDai1 = env.fyDais[1]
    fyDai2 = env.fyDais[2]

    // Setup Pools
    pool0 = await Pool.new(dai.address, fyDai0.address, 'Name', 'Symbol', { from: owner })
    pool1 = await Pool.new(dai.address, fyDai1.address, 'Name', 'Symbol', { from: owner })
    pool2 = await Pool.new(dai.address, fyDai2.address, 'Name', 'Symbol', { from: owner })

    // Allow owner to mint fyDai the sneaky way, without recording a debt in controller
    await fyDai0.orchestrate(owner, functionSignature('mint(address,uint256)'), { from: owner })
    await fyDai1.orchestrate(owner, functionSignature('mint(address,uint256)'), { from: owner })
    await fyDai2.orchestrate(owner, functionSignature('mint(address,uint256)'), { from: owner })

    // Setup PoolProxy
    proxy = await PoolProxy.new(controller.address)

    // Onboard users
    for (var user of [user1, user2, user3, user4, user5, user6, user7, user8]) {
      await env.maker.chai.approve(proxy.address, MAX, { from: user })
      await dai.approve(proxy.address, MAX, { from: user })
      await dai.approve(pool0.address, MAX, { from: user })
      await fyDai0.approve(pool0.address, MAX, { from: user })
      await controller.addDelegate(proxy.address, { from: user })
      await pool0.addDelegate(proxy.address, { from: user })
    }

    // Initialize pools
    const additionalFYDaiReserves = toWad(34.4)

    await env.maker.getDai(user1, initialDai, rate1)
    await dai.approve(pool0.address, initialDai, { from: user1 })
    await pool0.mint(user1, user1, initialDai, { from: user1 })
    await fyDai0.mint(owner, additionalFYDaiReserves, { from: owner })
    await fyDai0.approve(pool0.address, additionalFYDaiReserves, { from: owner })
    await pool0.sellFYDai(owner, owner, additionalFYDaiReserves, { from: owner })

    await env.maker.getDai(user1, initialDai, rate1)
    await dai.approve(pool1.address, initialDai, { from: user1 })
    await pool1.mint(user1, user1, initialDai, { from: user1 })
    await fyDai1.mint(owner, additionalFYDaiReserves, { from: owner })
    await fyDai1.approve(pool1.address, additionalFYDaiReserves, { from: owner })
    await pool1.sellFYDai(owner, owner, additionalFYDaiReserves, { from: owner })

    await env.maker.getDai(user1, initialDai, rate1)
    await dai.approve(pool2.address, initialDai, { from: user1 })
    await pool2.mint(user1, user1, initialDai, { from: user1 })
    await fyDai2.mint(owner, additionalFYDaiReserves, { from: owner })
    await fyDai2.approve(pool2.address, additionalFYDaiReserves, { from: owner })
    await pool2.sellFYDai(owner, owner, additionalFYDaiReserves, { from: owner })
  })

  afterEach(async () => {
    await helper.revertToSnapshot(snapshotId)
  })

  it('mints liquidity tokens with dai only', async () => {
    const oneToken = toWad(1)

    const poolTokensBefore = bnify((await pool0.balanceOf(user2)).toString())
    const maxFYDai = oneToken

    const daiReserves = bnify((await dai.balanceOf(pool0.address)).toString())
    const fyDaiReserves = bnify((await fyDai0.balanceOf(pool0.address)).toString())
    const daiUsed = bnify(oneToken)
    const poolSupply = bnify((await pool0.totalSupply()).toString())

    // console.log('          adding liquidity...')
    // console.log('          daiReserves: %d', daiReserves.toString())    // d_0
    // console.log('          fyDaiReserves: %d', fyDaiReserves.toString())  // y_0
    // console.log('          daiUsed: %d', daiUsed.toString())            // d_used

    // https://www.desmos.com/calculator/bl2knrktlt
    const expectedDaiIn = daiInForMint(daiReserves, fyDaiReserves, daiUsed) // d_in
    const expectedDebt = fyDaiInForMint(daiReserves, fyDaiReserves, daiUsed) // y_in
    // console.log('          expected daiInForMint: %d', expectedDaiIn)
    // console.log('          expected fyDaiInForMint: %d', expectedDebt)

    // console.log('          chi: %d', chi1)
    const expectedPosted = postedIn(expectedDebt, chi1)
    // console.log('          expected posted: %d', expectedPosted)         // p_chai

    // https://www.desmos.com/calculator/w9qorhrjbw
    // console.log('          Pool supply: %d', poolSupply)                 // s
    const expectedMinted = mintedOut(poolSupply, expectedDaiIn, daiReserves) // m
    // console.log('          expected minted: %d', expectedMinted)

    await dai.mint(user2, oneToken, { from: owner })
    await proxy.addLiquidityWithSignature(pool0.address, daiUsed, maxFYDai, '0x', '0x', { from: user2 })

    const debt = bnify((await controller.debtFYDai(CHAI, maturity0, user2)).toString())
    const posted = bnify((await controller.posted(CHAI, user2)).toString())
    const minted = bnify((await pool0.balanceOf(user2)).toString()).sub(poolTokensBefore)

    //asserts
    assert.equal(
      debt.toString(),
      expectedDebt.toString(),
      'User2 should have ' + expectedDebt + ' fyDai debt, instead has ' + debt.toString()
    )
    assert.equal(
      posted.toString(),
      expectedPosted.toString(),
      'User2 should have ' + expectedPosted + ' posted chai, instead has ' + posted.toString()
    )
    assert.equal(
      minted.toString(),
      expectedMinted.toString(),
      'User2 should have ' + expectedMinted + ' pool0 tokens, instead has ' + minted.toString()
    )
    // Proxy doesn't keep dai (beyond rounding)
    expect(await dai.balanceOf(proxy.address)).to.be.bignumber.lt(roundingProfit)
    // Proxy doesn't keep fyDai (beyond rounding)
    expect(await fyDai0.balanceOf(proxy.address)).to.be.bignumber.lt(roundingProfit)
    // Proxy doesn't keep liquidity (beyond rounding)
    expect(await pool0.balanceOf(proxy.address)).to.be.bignumber.lt(roundingProfit)
  })

  it('does not allow borrowing more than max amount', async () => {
    const oneToken = bnify(toWad(1))

    await dai.mint(user2, oneToken, { from: owner })
    await expectRevert(proxy.addLiquidity(pool0.address, oneToken, 1, { from: user2 }), 'PoolProxy: maxFYDai exceeded')
  })

  it('mints liquidity tokens buying fyDai in the pool', async () => {
    const oneToken = toWad(1)

    const daiReserves = bnify((await dai.balanceOf(pool0.address)).toString())
    const fyDaiRealReserves = bnify((await fyDai0.balanceOf(pool0.address)).toString())
    const fyDaiVirtualReserves = bnify((await pool0.getFYDaiReserves()).toString())
    const maxDaiUsed = bnify(oneToken)

    await dai.mint(user2, maxDaiUsed, { from: owner })
    const daiBalanceBefore = await dai.balanceOf(user2)

    const timeToMaturity =
      (await fyDai0.maturity()).toNumber() - (await web3.eth.getBlock(await web3.eth.getBlockNumber())).timestamp
    const fyDaiIn = fyDaiForMint(
      daiReserves.toString(),
      fyDaiRealReserves.toString(),
      fyDaiVirtualReserves.toString(),
      maxDaiUsed.toString(),
      timeToMaturity.toString()
    ).toString()
    await proxy.buyAddLiquidityWithSignature(pool0.address, fyDaiIn, maxDaiUsed, '0x', '0x', '0x', { from: user2 })

    const daiLeft = await dai.balanceOf(user2)
    const daiUsed = daiBalanceBefore.sub(daiLeft)
    const daiPrecision = bnify(maxDaiUsed).div(BigNumber.from('1000'))
    almostEqual(bnify(daiUsed), bnify(maxDaiUsed), daiPrecision)

    // Proxy doesn't keep dai (beyond rounding)
    expect(await dai.balanceOf(proxy.address)).to.be.bignumber.lt(roundingProfit)
    // Proxy doesn't keep fyDai (beyond rounding)
    expect(await fyDai0.balanceOf(proxy.address)).to.be.bignumber.lt(roundingProfit)
    // Proxy doesn't keep liquidity (beyond rounding)
    expect(await pool0.balanceOf(proxy.address)).to.be.bignumber.lt(roundingProfit)
  })

  it('does not add liquidity with slippage', async () => {
    const oneToken = new BN(toWad(1).toString())

    const daiReserves = bnify((await dai.balanceOf(pool0.address)).toString())
    const fyDaiRealReserves = bnify((await fyDai0.balanceOf(pool0.address)).toString())
    const fyDaiVirtualReserves = bnify((await pool0.getFYDaiReserves()).toString())
    const maxDaiUsed = oneToken

    await dai.mint(user2, maxDaiUsed, { from: owner })

    const timeToMaturity =
      (await fyDai0.maturity()).toNumber() - (await web3.eth.getBlock(await web3.eth.getBlockNumber())).timestamp
    const fyDaiIn = fyDaiForMint(
      daiReserves.toString(),
      fyDaiRealReserves.toString(),
      fyDaiVirtualReserves.toString(),
      maxDaiUsed.toString(),
      timeToMaturity.toString()
    ).toString()
    await expectRevert(
      proxy.buyAddLiquidityWithSignature(pool0.address, fyDaiIn, maxDaiUsed.divn(2), '0x', '0x', '0x', { from: user2 }),
      'PoolProxy: Limit exceeded'
    )
  })

  describe('with proxied liquidity', () => {
    beforeEach(async () => {
      const additionalFYDai = toWad(34.4)

      // Add liquidity to the pool0
      await fyDai0.mint(owner, additionalFYDai, { from: owner })
      await fyDai0.approve(pool0.address, additionalFYDai, { from: owner })
      await pool0.sellFYDai(owner, owner, additionalFYDai, { from: owner })

      // Add liquidity to the pool1
      await fyDai1.mint(owner, additionalFYDai, { from: owner })
      await fyDai1.approve(pool1.address, additionalFYDai, { from: owner })
      await pool1.sellFYDai(owner, owner, additionalFYDai, { from: owner })

      const oneToken = bnify(toWad(1))
      const maxBorrow = oneToken
      // Give some pool0 tokens to user2
      const users = [user2, user3, user4, user5, user6, user7, user8]
      for (let i in users) {
        await dai.mint(users[i], oneToken.mul(2), { from: owner })
        await dai.approve(proxy.address, MAX, { from: users[i] })
        await proxy.addLiquidityWithSignature(pool0.address, oneToken, maxBorrow, '0x', '0x', { from: users[i] })
        await proxy.addLiquidityWithSignature(pool1.address, oneToken, maxBorrow, '0x', '0x', { from: users[i] })
      }

      // Add some funds to the system to allow for rounding losses when withdrawing chai
      await maker.getChai(owner, 1000, chi1, rate1) // getChai can't get very small amounts
      await chai.approve(treasury.address, precision, { from: owner })
      await controller.post(CHAI, owner, owner, precision, { from: owner })

      await weth.deposit({ value: toWad(1).toString() })
      await weth.approve(treasury.address, MAX, { from: owner })
      await controller.post(WETH, owner, owner, toWad(1).toString(), { from: owner })
    })

    it('removes liquidity early by selling', async () => {
      // This scenario replicates a user with more debt that can be repaid by burning liquidity tokens.
      // It uses the pool0 to sell the obtained Dai, so it should be used when the pool0 rate is better than 1:1.
      // Sells once, repays once, and does nothing else so the gas cost is 178K.

      // Create some debt, so that there is no FYDai from the burn left to sell.
      await maker.getChai(user2, chaiTokens1, chi1, rate1)
      await chai.approve(treasury.address, chaiTokens1, { from: user2 })
      await controller.post(CHAI, user2, user2, chaiTokens1, { from: user2 })
      const toBorrow = (await env.unlockedOf(CHAI, user2)).toString()
      await controller.borrow(CHAI, maturity0, user2, user2, toBorrow, { from: user2 })

      const poolTokens = await pool0.balanceOf(user2)
      const debt = await controller.debtFYDai(CHAI, maturity0, user2)
      const daiBalance = await dai.balanceOf(user2)

      // Has pool0 tokens
      expect(poolTokens).to.be.bignumber.gt(ZERO)
      // Has fyDai debt
      expect(debt).to.be.bignumber.gt(ZERO)
      // Doesn't have dai
      expect(daiBalance).to.be.bignumber.eq(ZERO)
      // Has fyDai
      expect(await fyDai0.balanceOf(user2)).to.be.bignumber.eq(toBorrow)

      // the proxy must be a delegate in the pool0 because in order to remove
      // liquidity via the proxy we must authorize the proxy to burn from our balance
      await proxy.removeLiquidityEarlyDaiPool(pool0.address, poolTokens, '0', '0', { from: user2 }) // TODO: Test limits

      // Doesn't have pool0 tokens
      expect(await pool0.balanceOf(user2)).to.be.bignumber.eq(ZERO)
      // Has less fyDai debt
      expect(await controller.debtFYDai(CHAI, maturity0, user2)).to.be.bignumber.lt(debt)
      // Got some dai
      expect(await dai.balanceOf(user2)).to.be.bignumber.gt(ZERO)
      // Has the same fyDai
      expect(await fyDai0.balanceOf(user2)).to.be.bignumber.eq(toBorrow)
      // Proxy doesn't keep dai (beyond rounding)
      expect(await dai.balanceOf(proxy.address)).to.be.bignumber.lt(roundingProfit)
      // Proxy doesn't keep fyDai (beyond rounding)
      expect(await fyDai0.balanceOf(proxy.address)).to.be.bignumber.lt(roundingProfit)
      // Proxy doesn't keep liquidity (beyond rounding)
      expect(await pool0.balanceOf(proxy.address)).to.be.bignumber.lt(roundingProfit)
    })

    it('everyone can remove liquidity early by selling', async () => {
      const users = [user2, user3, user4, user5, user6, user7, user8]
      for (let i in users) {
        const poolTokens = await pool0.balanceOf(users[i])
        const debt = await controller.debtFYDai(CHAI, maturity0, users[i])
        const daiBalance = await dai.balanceOf(users[i])

        // Has pool0 tokens
        expect(poolTokens).to.be.bignumber.gt(ZERO)
        // Has fyDai debt
        expect(debt).to.be.bignumber.gt(ZERO)
        // Doesn't have dai
        expect(daiBalance).to.be.bignumber.eq(ZERO)

        // the proxy must be a delegate in the pool0 because in order to remove
        // liquidity via the proxy we must authorize the proxy to burn from our balance
        await proxy.removeLiquidityEarlyDaiPool(pool0.address, poolTokens, '0', '0', { from: users[i] }) // TODO: Test limits

        // Doesn't have pool0 tokens
        expect(await pool0.balanceOf(users[i])).to.be.bignumber.eq(ZERO)
        // Has less fyDai debt
        expect(await controller.debtFYDai(CHAI, maturity0, users[i])).to.be.bignumber.lt(debt)
        // Got some dai
        expect(await dai.balanceOf(users[i])).to.be.bignumber.gt(ZERO)
        // Proxy doesn't keep dai (beyond rounding)
        expect(await dai.balanceOf(proxy.address)).to.be.bignumber.lt(roundingProfit)
        // Proxy doesn't keep fyDai (beyond rounding)
        expect(await fyDai0.balanceOf(proxy.address)).to.be.bignumber.lt(roundingProfit)
        // Proxy doesn't keep liquidity (beyond rounding)
        expect(await pool0.balanceOf(proxy.address)).to.be.bignumber.lt(roundingProfit)
      }
    })

    it('removes liquidity early by selling, with some fyDai being sold in the pool0', async () => {
      // This scenario replicates a user with debt that can be repaid by burning liquidity tokens.
      // It uses the pool0 to sell the obtained Dai, so it should be used when the pool0 rate is better than 1:1.
      // Sells twice, repays once, and and withdraws, so the gas cost is about 400K.

      const poolTokens = await pool0.balanceOf(user2)
      const debt = await controller.debtFYDai(CHAI, maturity0, user2)
      const daiBalance = await dai.balanceOf(user2)

      // Has pool0 tokens
      expect(poolTokens).to.be.bignumber.gt(ZERO)
      // Has fyDai debt
      expect(debt).to.be.bignumber.gt(ZERO)
      // Doesn't have dai
      expect(daiBalance).to.be.bignumber.eq(ZERO)
      // Doesn't have fyDai
      expect(await fyDai0.balanceOf(user2)).to.be.bignumber.eq(ZERO)

      // the proxy must be a delegate in the pool0 because in order to remove
      // liquidity via the proxy we must authorize the proxy to burn from our balance
      await proxy.removeLiquidityEarlyDaiPool(pool0.address, poolTokens, '0', '0', { from: user2 }) // TODO: Test limits

      // Doesn't have pool0 tokens
      expect(await pool0.balanceOf(user2)).to.be.bignumber.eq(ZERO)
      // Has less fyDai debt
      expect(await controller.debtFYDai(CHAI, maturity0, user2)).to.be.bignumber.lt(debt)
      // Has more dai
      expect(await dai.balanceOf(user2)).to.be.bignumber.gt(daiBalance)
      // Doesn't have fyDai
      expect(await fyDai0.balanceOf(user2)).to.be.bignumber.eq(ZERO)
      // Proxy doesn't keep dai (beyond rounding)
      expect(await dai.balanceOf(proxy.address)).to.be.bignumber.lt(roundingProfit)
      // Proxy doesn't keep fyDai (beyond rounding)
      expect(await fyDai0.balanceOf(proxy.address)).to.be.bignumber.lt(roundingProfit)
      // Proxy doesn't keep liquidity (beyond rounding)
      expect(await pool0.balanceOf(proxy.address)).to.be.bignumber.lt(roundingProfit)
    })

    it('removes liquidity early by repaying, and uses all in paying debt', async () => {
      // This scenario replicates a user with more debt that can be repaid with fyDai and Dai obtained by burning liquidity tokens.
      // It repays with Dai at the Controller, so it should be used when the pool0 rate is worse than 1:1.
      // Repays fyDai and Dai, sells or withdraws withdraws nothing so the gas cost is 300K.

      // Create some debt, so that there is no FYDai from the burn left to sell.
      await maker.getChai(user2, chaiTokens1, chi1, rate1)
      await chai.approve(treasury.address, chaiTokens1, { from: user2 })
      await controller.post(CHAI, user2, user2, chaiTokens1, { from: user2 })
      const toBorrow = (await env.unlockedOf(CHAI, user2)).toString()
      await controller.borrow(CHAI, maturity0, user2, user2, toBorrow, { from: user2 })

      const poolTokens = await pool0.balanceOf(user2)
      const debt = await controller.debtFYDai(CHAI, maturity0, user2)
      const daiBalance = await dai.balanceOf(user2)

      // Has pool0 tokens
      expect(poolTokens).to.be.bignumber.gt(ZERO)
      // Has fyDai debt
      expect(debt).to.be.bignumber.gt(ZERO)
      // Doesn't have dai
      expect(daiBalance).to.be.bignumber.eq(ZERO)
      // Has fyDai
      expect(await fyDai0.balanceOf(user2)).to.be.bignumber.eq(toBorrow)

      // the proxy must be a delegate in the pool0 because in order to remove
      // liquidity via the proxy we must authorize the proxy to burn from our balance
      await proxy.removeLiquidityEarlyDaiFixedWithSignature(pool0.address, poolTokens, '0', '0x', '0x', { from: user2 }) // TODO: Test limits

      // Doesn't have pool0 tokens
      expect(await pool0.balanceOf(user2)).to.be.bignumber.eq(ZERO)
      // Has less fyDai debt
      expect(await controller.debtFYDai(CHAI, maturity0, user2)).to.be.bignumber.lt(debt)
      // Doesn't have dai
      expect(daiBalance).to.be.bignumber.eq(ZERO)
      // Has the same fyDai
      expect(await fyDai0.balanceOf(user2)).to.be.bignumber.eq(toBorrow)
      // Proxy doesn't keep dai (beyond rounding)
      expect(await dai.balanceOf(proxy.address)).to.be.bignumber.lt(roundingProfit)
      // Proxy doesn't keep fyDai (beyond rounding)
      expect(await fyDai0.balanceOf(proxy.address)).to.be.bignumber.lt(roundingProfit)
      // Proxy doesn't keep liquidity (beyond rounding)
      expect(await pool0.balanceOf(proxy.address)).to.be.bignumber.lt(roundingProfit)
    })

    it('removes liquidity early by repaying, and has Dai left', async () => {
      // This scenario replicates a user with debt that can be repaid with fyDai and Dai obtained by burning liquidity tokens.
      // It repays with Dai at the Controller, so it should be used when the pool0 rate is worse than 1:1.
      // Repays fyDai and Dai, withdraws Dai and Chai so the gas cost is 394K.

      const poolTokens = await pool0.balanceOf(user2)
      const debt = await controller.debtFYDai(CHAI, maturity0, user2)
      const daiBalance = await dai.balanceOf(user2)

      // Has pool0 tokens
      expect(poolTokens).to.be.bignumber.gt(ZERO)
      // Has fyDai debt
      expect(debt).to.be.bignumber.gt(ZERO)
      // Doesn't have dai
      expect(daiBalance).to.be.bignumber.eq(ZERO)
      // Doesn't have fyDai
      expect(await fyDai0.balanceOf(user2)).to.be.bignumber.eq(ZERO)

      // the proxy must be a delegate in the pool0 because in order to remove
      // liquidity via the proxy we must authorize the proxy to burn from our balance
      await proxy.removeLiquidityEarlyDaiFixedWithSignature(pool0.address, poolTokens, '0', '0x', '0x', { from: user2 }) // TODO: Test limits

      // Doesn't have pool0 tokens
      expect(await pool0.balanceOf(user2)).to.be.bignumber.eq(ZERO)
      // Has less fyDai debt
      expect(await controller.debtFYDai(CHAI, maturity0, user2)).to.be.bignumber.lt(debt)
      // Has more dai
      expect(await dai.balanceOf(user2)).to.be.bignumber.gt(daiBalance)
      // Doesn't have fyDai
      expect(await fyDai0.balanceOf(user2)).to.be.bignumber.eq(ZERO)
      // Proxy doesn't keep dai (beyond rounding)
      expect(await dai.balanceOf(proxy.address)).to.be.bignumber.lt(roundingProfit)
      // Proxy doesn't keep fyDai (beyond rounding)
      expect(await fyDai0.balanceOf(proxy.address)).to.be.bignumber.lt(roundingProfit)
      // Proxy doesn't keep liquidity (beyond rounding)
      expect(await pool0.balanceOf(proxy.address)).to.be.bignumber.lt(roundingProfit)
    })

    it('everyone can remove liquidity early by repaying', async () => {
      const users = [user2, user3, user4, user5, user6, user7, user8]
      for (let i in users) {
        const poolTokens = await pool0.balanceOf(users[i])
        const debt = await controller.debtFYDai(CHAI, maturity0, users[i])
        const daiBalance = await dai.balanceOf(users[i])

        // Has pool0 tokens
        expect(poolTokens).to.be.bignumber.gt(ZERO)
        // Has fyDai debt
        expect(debt).to.be.bignumber.gt(ZERO)
        // Doesn't have dai
        expect(daiBalance).to.be.bignumber.eq(ZERO)
        // Doesn't have fyDai
        expect(await fyDai0.balanceOf(users[i])).to.be.bignumber.eq(ZERO)

        // the proxy must be a delegate in the pool0 because in order to remove
        // liquidity via the proxy we must authorize the proxy to burn from our balance
        await proxy.removeLiquidityEarlyDaiFixedWithSignature(pool0.address, poolTokens, '0', '0x', '0x', {
          from: users[i],
        }) // TODO: Test limits

        // Doesn't have pool0 tokens
        expect(await pool0.balanceOf(users[i])).to.be.bignumber.eq(ZERO)
        // Has less fyDai debt
        expect(await controller.debtFYDai(CHAI, maturity0, users[i])).to.be.bignumber.lt(debt)
        // Has more dai
        expect(await dai.balanceOf(users[i])).to.be.bignumber.gt(daiBalance)
        // Doesn't have fyDai
        expect(await fyDai0.balanceOf(users[i])).to.be.bignumber.eq(ZERO)
        // Proxy doesn't keep dai (beyond rounding)
        expect(await dai.balanceOf(proxy.address)).to.be.bignumber.lt(roundingProfit)
        // Proxy doesn't keep fyDai (beyond rounding)
        expect(await fyDai0.balanceOf(proxy.address)).to.be.bignumber.lt(roundingProfit)
        // Proxy doesn't keep liquidity (beyond rounding)
        expect(await pool0.balanceOf(proxy.address)).to.be.bignumber.lt(roundingProfit)
      }
    })

    it('removes liquidity early by repaying, and has Dai and fyDai left', async () => {
      // This scenario replicates a user with debt that can be repaid with fyDai and Dai obtained by burning liquidity tokens.
      // It repays with Dai at the Controller, so it should be used when the pool0 rate is worse than 1:1.
      // Repays fyDai, sells fyDai, withdraws Dai and Chai so the gas cost is 333K.

      const poolTokens = await pool0.balanceOf(user2)
      const debt = await controller.debtFYDai(CHAI, maturity0, user2)
      const daiBalance = await dai.balanceOf(user2)

      // Has pool0 tokens
      expect(poolTokens).to.be.bignumber.gt(ZERO)
      // Has fyDai debt
      expect(debt).to.be.bignumber.gt(ZERO)
      // Doesn't have dai
      expect(daiBalance).to.be.bignumber.eq(ZERO)
      // Doesn't have fyDai
      expect(await fyDai0.balanceOf(user2)).to.be.bignumber.eq(ZERO)

      // Pay some debt, so that there is FYDai from the burn left to sell.
      await fyDai0.mint(user2, debt.div(new BN('2')), { from: owner })
      await controller.repayFYDai(CHAI, maturity0, user2, user2, debt.div(new BN('2')), { from: user2 })

      // the proxy must be a delegate in the pool0 because in order to remove
      // liquidity via the proxy we must authorize the proxy to burn from our balance
      await proxy.removeLiquidityEarlyDaiFixedWithSignature(pool0.address, poolTokens, '0', '0x', '0x', { from: user2 }) // TODO: Test limits

      // Doesn't have pool0 tokens
      expect(await pool0.balanceOf(user2)).to.be.bignumber.eq(ZERO)
      // Has less fyDai debt
      expect(await controller.debtFYDai(CHAI, maturity0, user2)).to.be.bignumber.lt(debt)
      // Has more dai
      expect(await dai.balanceOf(user2)).to.be.bignumber.gt(daiBalance)
      // Doesn't have fyDai
      expect(await fyDai0.balanceOf(user2)).to.be.bignumber.eq(ZERO)
      // Proxy doesn't keep dai (beyond rounding)
      expect(await dai.balanceOf(proxy.address)).to.be.bignumber.lt(roundingProfit)
      // Proxy doesn't keep fyDai (beyond rounding)
      expect(await fyDai0.balanceOf(proxy.address)).to.be.bignumber.lt(roundingProfit)
      // Proxy doesn't keep liquidity (beyond rounding)
      expect(await pool0.balanceOf(proxy.address)).to.be.bignumber.lt(roundingProfit)
    })

    it("doesn't remove liquidity if minimum prices not achieved", async () => {
      const poolTokens = await pool0.balanceOf(user2)
      const debt = await controller.debtFYDai(CHAI, maturity0, user2)
      const daiBalance = await dai.balanceOf(user2)

      // Has pool0 tokens
      expect(poolTokens).to.be.bignumber.gt(ZERO)
      // Has fyDai debt
      expect(debt).to.be.bignumber.gt(ZERO)
      // Doesn't have dai
      expect(daiBalance).to.be.bignumber.eq(ZERO)
      // Doesn't have fyDai
      expect(await fyDai0.balanceOf(user2)).to.be.bignumber.eq(ZERO)

      // the proxy must be a delegate in the pool0 because in order to remove
      // liquidity via the proxy we must authorize the proxy to burn from our balance
      await expectRevert(
        proxy.removeLiquidityEarlyDaiPool(pool0.address, poolTokens, toRay(2), '0', { from: user2 }),
        'PoolProxy: minimumDaiPrice not reached'
      )
      await expectRevert(
        proxy.removeLiquidityEarlyDaiPool(pool0.address, poolTokens, '0', toRay(2), { from: user2 }),
        'PoolProxy: minimumFYDaiPrice not reached'
      )
    })

    it('removes liquidity after maturity by redeeming', async () => {
      await helper.advanceTime(31556952)
      await helper.advanceBlock()
      await fyDai0.mature()

      const poolTokens = await pool0.balanceOf(user2)
      const debt = await controller.debtFYDai(CHAI, maturity0, user2)
      const daiBalance = await dai.balanceOf(user2)

      // Has pool0 tokens
      expect(poolTokens).to.be.bignumber.gt(ZERO)
      // Has fyDai debt
      expect(debt).to.be.bignumber.gt(ZERO)
      // Doesn't have dai
      expect(daiBalance).to.be.bignumber.eq(ZERO)
      // Doesn't have fyDai
      expect(await fyDai0.balanceOf(user2)).to.be.bignumber.eq(ZERO)

      await proxy.removeLiquidityMatureWithSignature(pool0.address, poolTokens, '0x', '0x', { from: user2 })

      // Doesn't have pool0 tokens
      expect(await pool0.balanceOf(user2)).to.be.bignumber.eq(ZERO)
      // Has less fyDai debt
      expect(await controller.debtFYDai(CHAI, maturity0, user2)).to.be.bignumber.lt(debt)
      // Has more dai
      expect(await dai.balanceOf(user2)).to.be.bignumber.gt(daiBalance)
      // Doesn't have fyDai
      expect(await fyDai0.balanceOf(user2)).to.be.bignumber.eq(ZERO)
      // Proxy doesn't keep dai (beyond rounding)
      expect(await dai.balanceOf(proxy.address)).to.be.bignumber.lt(roundingProfit)
      // Proxy doesn't keep fyDai (beyond rounding)
      expect(await fyDai0.balanceOf(proxy.address)).to.be.bignumber.lt(roundingProfit)
      // Proxy doesn't keep liquidity (beyond rounding)
      expect(await pool0.balanceOf(proxy.address)).to.be.bignumber.lt(roundingProfit)
    })

    it('everyone can remove liquidity after maturity by redeeming', async () => {
      await helper.advanceTime(31556952)
      await helper.advanceBlock()
      await fyDai0.mature()

      const users = [user2, user3, user4, user5, user6, user7, user8]
      for (let i in users) {
        const poolTokens = await pool0.balanceOf(users[i])
        const debt = await controller.debtFYDai(CHAI, maturity0, users[i])
        const daiBalance = await dai.balanceOf(users[i])

        // Has pool0 tokens
        expect(poolTokens).to.be.bignumber.gt(ZERO)
        // Has fyDai debt
        expect(debt).to.be.bignumber.gt(ZERO)
        // Doesn't have dai
        expect(daiBalance).to.be.bignumber.eq(ZERO)
        // Doesn't have fyDai
        expect(await fyDai0.balanceOf(user2)).to.be.bignumber.eq(ZERO)

        // the proxy must be a delegate in the pool0 because in order to remove
        // liquidity via the proxy we must authorize the proxy to burn from our balance
        await proxy.removeLiquidityMatureWithSignature(pool0.address, poolTokens, '0x', '0x', { from: users[i] })

        // Doesn't have pool0 tokens
        expect(await pool0.balanceOf(users[i])).to.be.bignumber.eq(ZERO)
        // Has less fyDai debt
        expect(await controller.debtFYDai(CHAI, maturity0, users[i])).to.be.bignumber.lt(debt)
        // Has more dai
        expect(await dai.balanceOf(user2)).to.be.bignumber.gt(daiBalance)
        // Proxy doesn't keep dai (beyond rounding)
        expect(await dai.balanceOf(proxy.address)).to.be.bignumber.lt(roundingProfit)
        // Proxy doesn't keep fyDai (beyond rounding)
        expect(await fyDai0.balanceOf(proxy.address)).to.be.bignumber.lt(roundingProfit)
        // Proxy doesn't keep liquidity (beyond rounding)
        expect(await pool0.balanceOf(proxy.address)).to.be.bignumber.lt(roundingProfit)
      }
    })

    it('and I mean everyone', async () => {
      await helper.advanceTime(31556952)
      await helper.advanceBlock()
      await fyDai0.mature()

      const users = [user1, user2, user3, user4, user5, user6, user7, user8]
      for (let i in users) {
        const poolTokens = await pool0.balanceOf(users[i])
        await proxy.removeLiquidityMatureWithSignature(pool0.address, poolTokens, '0x', '0x', { from: users[i] })
      }
      console.log(`           Remaining Dai:   ${(await pool0.getDaiReserves()).toString()}`)
      console.log(`           Remaining fyDai: ${(await pool0.getFYDaiReserves()).toString()}`)
    })
  })
})
