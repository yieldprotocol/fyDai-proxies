const Pool = artifacts.require('Pool')
const FlashBorrower = artifacts.require('YieldFlashBorrowerMock')

import { keccak256, toUtf8Bytes } from 'ethers/lib/utils'
// @ts-ignore
import helper from 'ganache-time-traveler'
import { rate1, daiTokens1, toWad, almostEqual } from './shared/utils'
import { MakerEnvironment, YieldEnvironmentLite, Contract } from './shared/fixtures'
// @ts-ignore
import { BN, expectRevert } from '@openzeppelin/test-helpers'
import { assert } from 'chai'

contract('YieldFlashBorrower', async (accounts) => {
  let [owner, user1] = accounts

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
  let borrower: Contract

  let maturity0: number
  let maturity1: number
  let maturity2: number

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
    await fyDai0.orchestrate(owner, keccak256(toUtf8Bytes('mint(address,uint256)')), { from: owner })
    await fyDai1.orchestrate(owner, keccak256(toUtf8Bytes('mint(address,uint256)')), { from: owner })
    await fyDai2.orchestrate(owner, keccak256(toUtf8Bytes('mint(address,uint256)')), { from: owner })

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

    // Set up the FlashBorrower
    borrower = await FlashBorrower.new(dai.address, { from: owner })
    await borrower.setPool(pool0.address, { from: owner })
  })

  it('should do a simple flash loan from an EOA', async () => {
    const ONE = new BN(toWad(1).toString())
    const loan = ONE

    const expectedFee = await borrower.flashFee(loan)

    await env.maker.getDai(user1, ONE.toString(), rate1)
    await dai.transfer(borrower.address, ONE, { from: user1 })

    const balanceBefore = await dai.balanceOf(borrower.address)
    await borrower.flashBorrow(loan, { from: user1 })

    assert.equal(await borrower.sender(), user1)

    assert.equal((await borrower.loanAmount()).toString(), loan.toString())

    assert.equal((await borrower.balance()).toString(), balanceBefore.add(loan).toString())

    const fee = await borrower.fee()
    assert.equal((await dai.balanceOf(borrower.address)).toString(), balanceBefore.sub(fee).toString())
    almostEqual(fee.toString(), expectedFee.toString(), fee.div(new BN('100000')).toString()) // Accurate to 0.00001 %
  })
})
