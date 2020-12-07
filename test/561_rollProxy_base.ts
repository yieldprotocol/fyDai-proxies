const Pool = artifacts.require('Pool')
const RollProxy = artifacts.require('RollProxy')

import { keccak256, toUtf8Bytes } from 'ethers/lib/utils'
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
} from './shared/utils'
import { MakerEnvironment, YieldEnvironmentLite, Contract } from './shared/fixtures'
// @ts-ignore
import { BN, expectRevert } from '@openzeppelin/test-helpers'
import { assert, expect } from 'chai'
import { BigNumber } from 'ethers'

contract('RollProxy', async (accounts) => {
  let [owner, user1, user2, user3, user4, user5, user6, user7, user8, user9] = accounts

  const initialDai = new BN(toWad('10000').toString())
  const additionalFYDai = new BN(toWad('10000').toString())

  let snapshot: any
  let snapshotId: string

  let maker: MakerEnvironment
  let env: YieldEnvironmentLite
  let treasury: Contract
  let controller: Contract

  let weth: Contract
  let dai: Contract
  let chai: Contract
  let pool1: Contract
  let fyDai0: Contract
  let pool2: Contract
  let proxy: Contract

  let maturity0: number

  const roundingProfit: any = new BN('100') // Some wei remain in proxy with each operation due to rounding

  const daiIn = (daiReserves: BigNumber, fyDaiReserves: BigNumber, daiUsed: BigNumber): BigNumber => {
    return daiUsed.mul(daiReserves).div(daiReserves.add(fyDaiReserves))
  }

  const fyDaiIn = (daiReserves: BigNumber, fyDaiReserves: BigNumber, daiUsed: BigNumber): BigNumber => {
    return daiUsed.mul(fyDaiReserves).div(daiReserves.add(fyDaiReserves))
  }

  const postedIn = (expectedDebt: BigNumber, chi: BigNumber): BigNumber => {
    return divrup(expectedDebt.mul(toRay(1)), bnify(chi))
  }

  const mintedOut = (poolSupply: BigNumber, daiIn: BigNumber, daiReserves: BigNumber): BigNumber => {
    return poolSupply.mul(daiIn).div(daiReserves)
  }

  beforeEach(async () => {
    snapshot = await helper.takeSnapshot()
    snapshotId = snapshot['result']

    // Setup fyDai
    const block = await web3.eth.getBlockNumber()
    maturity0 = (await web3.eth.getBlock(block)).timestamp + 15778476 // Six months

    env = await YieldEnvironmentLite.setup([maturity0])
    maker = env.maker
    weth = env.maker.weth
    dai = env.maker.dai
    chai = env.maker.chai
    treasury = env.treasury
    controller = env.controller
    fyDai0 = env.fyDais[0]

    // Setup Pools
    pool1 = await Pool.new(dai.address, fyDai0.address, 'Name', 'Symbol', { from: owner })
    pool2 = await Pool.new(dai.address, fyDai0.address, 'Name', 'Symbol', { from: owner })

    // Allow owner to mint fyDai the sneaky way, without recording a debt in controller
    await fyDai0.orchestrate(owner, keccak256(toUtf8Bytes('mint(address,uint256)')), { from: owner })

    // Setup RollProxy
    proxy = await RollProxy.new(controller.address)
    await proxy.migrateLiquidityApprove(pool1.address, pool2.address, { from: owner })

    // Onboard users
    const users = [owner, user1, user2]
    for (let i in users) {
      await env.maker.chai.approve(proxy.address, MAX, { from: users[i] })
      await chai.approve(treasury.address, precision, { from: users[i] })
      await dai.approve(proxy.address, MAX, { from: users[i] })
      await dai.approve(pool1.address, MAX, { from: users[i] })
      await dai.approve(pool2.address, MAX, { from: users[i] })
      await fyDai0.approve(proxy.address, MAX, { from: users[i] })
      await fyDai0.approve(pool1.address, MAX, { from: users[i] })
      await fyDai0.approve(pool2.address, MAX, { from: users[i] })

      await controller.addDelegate(proxy.address, { from: users[i] })
      await pool1.addDelegate(proxy.address, { from: users[i] })
      await pool2.addDelegate(proxy.address, { from: users[i] })
    }

    // Initialize pools and get lp tokens
    await env.maker.getDai(user1, initialDai.toString(), rate1)
    await pool1.mint(user1, user1, initialDai, { from: user1 })
    await fyDai0.mint(owner, additionalFYDai, { from: owner })
    await pool1.sellFYDai(owner, owner, additionalFYDai, { from: owner })

    await env.maker.getDai(user1, initialDai.toString(), rate1)
    await pool2.mint(user1, user1, initialDai, { from: user1 })
    await fyDai0.mint(owner, additionalFYDai, { from: owner })
    await pool2.sellFYDai(owner, owner, additionalFYDai, { from: owner })

    // Add some funds to the system to allow for rounding losses when withdrawing chai
    await maker.getChai(owner, 1000, chi1, rate1) // getChai can't get very small amounts
    await controller.post(CHAI, owner, owner, precision, { from: owner })
  })

  afterEach(async () => {
    await helper.revertToSnapshot(snapshotId)
  })

  it('migrates liquidity between pools with dai proportion on destination above proportion on source', async () => {
    const poolTokens = await pool1.balanceOf(user1)
    const debt = await controller.debtFYDai(CHAI, maturity0, user1)
    const daiBalance = await dai.balanceOf(user1)

    const fyDaiToSell = initialDai.div(new BN('10')).toString()
    await fyDai0.mint(owner, fyDaiToSell, { from: owner })
    await pool1.sellFYDai(owner, owner, fyDaiToSell, { from: owner })

    // Has pool1 tokens
    // expect(poolTokens).to.be.bignumber.gt(ZERO)
    // Has fyDai debt
    // expect(debt).to.be.bignumber.gt(ZERO)
    // Doesn't have dai
    // expect(daiBalance).to.be.bignumber.eq(ZERO)
    // Has fyDai
    // expect(await fyDai0.balanceOf(user2)).to.be.bignumber.eq(toBorrow)

    await proxy.migrateLiquidity(pool1.address, pool2.address, poolTokens, { from: user1 })

    // Doesn't have pool1 tokens
    // expect(await pool1.balanceOf(user2)).to.be.bignumber.eq(ZERO)
    // Has less fyDai debt
    // expect(await controller.debtFYDai(CHAI, maturity0, user2)).to.be.bignumber.lt(debt)
    // Got some dai
    // expect(await dai.balanceOf(user2)).to.be.bignumber.gt(ZERO)
    // Has the same fyDai
    // expect(await fyDai0.balanceOf(user2)).to.be.bignumber.eq(toBorrow)
    // Proxy doesn't keep dai (beyond rounding)
    // expect(await dai.balanceOf(proxy.address)).to.be.bignumber.lt(roundingProfit)
    // Proxy doesn't keep fyDai (beyond rounding)
    // expect(await fyDai0.balanceOf(proxy.address)).to.be.bignumber.lt(roundingProfit)
    // Proxy doesn't keep liquidity (beyond rounding)
    // expect(await pool1.balanceOf(proxy.address)).to.be.bignumber.lt(roundingProfit)
  })

  it('migrates liquidity between pools with dai proportion on source above proportion on destination', async () => {
    const poolTokens = await pool1.balanceOf(user1)
    const debt = await controller.debtFYDai(CHAI, maturity0, user1)
    const daiBalance = await dai.balanceOf(user1)

    const fyDaiToSell = initialDai.div(new BN('10')).toString()
    await fyDai0.mint(owner, fyDaiToSell, { from: owner })
    await pool2.sellFYDai(owner, owner, fyDaiToSell, { from: owner })

    // Has pool1 tokens
    // expect(poolTokens).to.be.bignumber.gt(ZERO)
    // Has fyDai debt
    // expect(debt).to.be.bignumber.gt(ZERO)
    // Doesn't have dai
    // expect(daiBalance).to.be.bignumber.eq(ZERO)
    // Has fyDai
    // expect(await fyDai0.balanceOf(user2)).to.be.bignumber.eq(toBorrow)

    await proxy.migrateLiquidity(pool1.address, pool2.address, poolTokens, { from: user1 })

    // Doesn't have pool1 tokens
    // expect(await pool1.balanceOf(user2)).to.be.bignumber.eq(ZERO)
    // Has less fyDai debt
    // expect(await controller.debtFYDai(CHAI, maturity0, user2)).to.be.bignumber.lt(debt)
    // Got some dai
    // expect(await dai.balanceOf(user2)).to.be.bignumber.gt(ZERO)
    // Has the same fyDai
    // expect(await fyDai0.balanceOf(user2)).to.be.bignumber.eq(toBorrow)
    // Proxy doesn't keep dai (beyond rounding)
    // expect(await dai.balanceOf(proxy.address)).to.be.bignumber.lt(roundingProfit)
    // Proxy doesn't keep fyDai (beyond rounding)
    // expect(await fyDai0.balanceOf(proxy.address)).to.be.bignumber.lt(roundingProfit)
    // Proxy doesn't keep liquidity (beyond rounding)
    // expect(await pool1.balanceOf(proxy.address)).to.be.bignumber.lt(roundingProfit)
  })
})
