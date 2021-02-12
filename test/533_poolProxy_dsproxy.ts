const Pool = artifacts.require('Pool')
const PoolProxy = artifacts.require('PoolProxy')
const DSProxy = artifacts.require('DSProxy')
const DSProxyFactory = artifacts.require('DSProxyFactory')
const DSProxyRegistry = artifacts.require('ProxyRegistry')

import { getSignatureDigest, getDaiDigest, getPermitDigest, user2PrivateKey, sign } from './shared/signatures'
// @ts-ignore
import helper from 'ganache-time-traveler'
import {
  CHAI,
  chi1,
  rate1,
  daiTokens1,
  toWad,
  precision,
  bnify,
  chainId,
  name,
  MAX,
  functionSignature,
} from './shared/utils'
import { MakerEnvironment, YieldEnvironmentLite, Contract } from './shared/fixtures'

contract('PoolProxy - DSProxy', async (accounts) => {
  let [owner, user1, user2, operator, to] = accounts

  const initialDai = daiTokens1

  let snapshot: any
  let snapshotId: string

  let maker: MakerEnvironment
  let env: YieldEnvironmentLite
  let treasury: Contract
  let controller: Contract

  let dai: Contract
  let chai: Contract
  let pool0: Contract
  let fyDai0: Contract
  let pool1: Contract
  let fyDai1: Contract
  let poolProxy: Contract

  let proxyFactory: Contract
  let proxyRegistry: Contract
  let dsProxy: Contract

  let maturity0: number
  let maturity1: number

  describe('disable timeout', async function () {
    this.timeout(0)

    beforeEach(async () => {
      snapshot = await helper.takeSnapshot()
      snapshotId = snapshot['result']

      // Setup fyDai
      const block = await web3.eth.getBlockNumber()
      maturity0 = (await web3.eth.getBlock(block)).timestamp + 15778476 // Six months
      maturity1 = (await web3.eth.getBlock(block)).timestamp + 31556952 // One year

      env = await YieldEnvironmentLite.setup([maturity0, maturity1])
      maker = env.maker
      dai = env.maker.dai
      chai = env.maker.chai
      treasury = env.treasury
      controller = env.controller
      fyDai0 = env.fyDais[0]
      fyDai1 = env.fyDais[1]

      // Setup Pools
      pool0 = await Pool.new(dai.address, fyDai0.address, 'Name', 'Symbol', { from: owner })
      pool1 = await Pool.new(dai.address, fyDai1.address, 'Name', 'Symbol', { from: owner })

      // Allow owner to mint fyDai the sneaky way, without recording a debt in controller
      await fyDai0.orchestrate(owner, functionSignature('mint(address,uint256)'), { from: owner })
      await fyDai1.orchestrate(owner, functionSignature('mint(address,uint256)'), { from: owner })

      // Setup PoolProxy
      poolProxy = await PoolProxy.new(controller.address)

      // Setup DSProxyFactory and DSProxyCache
      proxyFactory = await DSProxyFactory.new({ from: owner })

      // Setup DSProxyRegistry
      proxyRegistry = await DSProxyRegistry.new(proxyFactory.address, { from: owner })
    })

    afterEach(async () => {
      await helper.revertToSnapshot(snapshotId)
    })

    describe('without onboarding', () => {
      let daiSig: any, controllerSig: any, poolSig: any, daiPoolSig: any, fyDaiPoolSig: any

      beforeEach(async () => {
        // user1 sets the scene, user2 will interact without onboarding
        await env.maker.chai.approve(poolProxy.address, MAX, { from: user1 })
        await dai.approve(poolProxy.address, MAX, { from: user1 })
        await dai.approve(pool0.address, MAX, { from: user1 })
        await controller.addDelegate(poolProxy.address, { from: user1 })

        const additionalFYDai = toWad(34.4)

        await env.maker.getDai(user1, initialDai, rate1)
        await dai.approve(pool0.address, initialDai, { from: user1 })
        await pool0.mint(user1, user1, initialDai, { from: user1 })
        await fyDai0.mint(operator, additionalFYDai, { from: owner })
        await fyDai0.approve(pool0.address, additionalFYDai, { from: operator })
        await pool0.sellFYDai(operator, operator, additionalFYDai, { from: operator })

        await env.maker.getDai(user1, initialDai, rate1)
        await dai.approve(pool1.address, initialDai, { from: user1 })
        await pool1.mint(user1, user1, initialDai, { from: user1 })
        await fyDai1.mint(operator, additionalFYDai, { from: owner })
        await fyDai1.approve(pool1.address, additionalFYDai, { from: operator })
        await pool1.sellFYDai(operator, operator, additionalFYDai, { from: operator })

        // Add liquidity to the pool0
        await fyDai0.mint(operator, additionalFYDai, { from: owner })
        await fyDai0.approve(pool0.address, additionalFYDai, { from: operator })
        await pool0.sellFYDai(operator, operator, additionalFYDai, { from: operator })

        // Add liquidity to the pool1
        await fyDai1.mint(operator, additionalFYDai, { from: owner })
        await fyDai1.approve(pool1.address, additionalFYDai, { from: operator })
        await pool1.sellFYDai(operator, operator, additionalFYDai, { from: operator })

        // Add some funds to the system to allow for rounding losses when withdrawing chai
        await maker.getChai(owner, 1000, chi1, rate1) // getChai can't get very small amounts
        await chai.approve(treasury.address, precision, { from: owner })
        await controller.post(CHAI, owner, owner, precision, { from: owner })

        // Sets DSProxy for user2
        await proxyRegistry.build({ from: user2 })
        dsProxy = await DSProxy.at(await proxyRegistry.proxies(user2))

        // Authorize DAI
        const deadline = MAX
        const daiDigest = getDaiDigest(
          await dai.name(),
          dai.address,
          chainId,
          {
            owner: user2,
            spender: dsProxy.address,
            can: true,
          },
          bnify(await dai.nonces(user2)),
          deadline
        )
        daiSig = sign(daiDigest, user2PrivateKey)

        // Authorize the proxy for the controller
        const controllerDigest = getSignatureDigest(
          name,
          controller.address,
          chainId,
          {
            user: user2,
            delegate: dsProxy.address,
          },
          (await controller.signatureCount(user2)).toString(),
          MAX
        )
        controllerSig = sign(controllerDigest, user2PrivateKey)

        // Authorize the proxy for the pool0
        const poolDigest = getSignatureDigest(
          name,
          pool0.address,
          chainId,
          {
            user: user2,
            delegate: dsProxy.address,
          },
          (await pool0.signatureCount(user2)).toString(),
          MAX
        )
        poolSig = sign(poolDigest, user2PrivateKey)

        // Authorize DAI for the pool0
        const daiPoolDigest = getDaiDigest(
          await dai.name(),
          dai.address,
          chainId,
          {
            owner: user2,
            spender: pool0.address,
            can: true,
          },
          bnify(await dai.nonces(user2)),
          deadline
        )
        daiPoolSig = sign(daiPoolDigest, user2PrivateKey)

        // Authorize fyDAI for the pool0
        const fyDaiPoolDigest = getPermitDigest(
          await fyDai0.name(),
          fyDai0.address,
          chainId,
          {
            owner: user2,
            spender: pool0.address,
            value: MAX,
          },
          bnify(await fyDai0.nonces(user2)),
          deadline
        )
        fyDaiPoolSig = sign(fyDaiPoolDigest, user2PrivateKey)
      })

      it('adds liquidity', async () => {
        const oneToken = toWad(1)
        const maxFYDai = oneToken
        const daiUsed = bnify(oneToken)

        await dai.mint(user2, oneToken, { from: owner })

        const calldata = poolProxy.contract.methods
          .addLiquidityWithSignature(pool0.address, daiUsed.toString(), maxFYDai.toString(), daiSig, controllerSig)
          .encodeABI()
        await dsProxy.methods['execute(address,bytes)'](poolProxy.address, calldata, {
          from: user2,
        })
      })

      it('adds liquidity by buying fyDai in the pool', async () => {
        const oneToken = toWad(1)

        await dai.mint(user2, oneToken.mul(100), { from: owner })

        const calldata = poolProxy.contract.methods
          .buyAddLiquidityWithSignature(pool0.address, oneToken, MAX, daiPoolSig, fyDaiPoolSig, poolSig)
          .encodeABI()
        await dsProxy.methods['execute(address,bytes)'](poolProxy.address, calldata, {
          from: user2,
        })
      })

      describe('with liquidity', () => {
        beforeEach(async () => {
          // Onboard for adding liquidity
          await dai.approve(poolProxy.address, MAX, { from: user2 })
          await controller.addDelegate(poolProxy.address, { from: user2 })

          const oneToken = bnify(toWad(1))
          const maxBorrow = oneToken
          // Give some pool0 tokens to user2
          await dai.mint(user2, oneToken, { from: owner })
          await poolProxy.addLiquidityWithSignature(pool0.address, oneToken, maxBorrow, '0x', '0x', { from: user2 })

          // Give some pool1 tokens to user2
          await dai.mint(user2, oneToken, { from: owner })
          await poolProxy.addLiquidityWithSignature(pool1.address, oneToken, maxBorrow, '0x', '0x', { from: user2 })

          // Authorize the proxy for the pool
          const poolDigest = getSignatureDigest(
            name,
            pool0.address,
            chainId,
            {
              user: user2,
              delegate: dsProxy.address,
            },
            (await pool0.signatureCount(user2)).toString(),
            MAX
          )
          poolSig = sign(poolDigest, user2PrivateKey)

          await controller.revokeDelegate(poolProxy.address, { from: user2 })
        })

        it('removes liquidity early by selling with the pool and controller signatures', async () => {
          const poolTokens = (await pool0.balanceOf(user2)).toString()

          const calldata = poolProxy.contract.methods
            .removeLiquidityEarlyDaiPoolWithSignature(
              pool0.address,
              poolTokens.toString(),
              '0',
              '0',
              controllerSig,
              poolSig
            )
            .encodeABI()
          await dsProxy.methods['execute(address,bytes)'](poolProxy.address, calldata, {
            from: user2,
          })
        })

        it('removes liquidity early by repaying', async () => {
          const poolTokens = (await pool0.balanceOf(user2)).toString()

          const calldata = poolProxy.contract.methods
            .removeLiquidityEarlyDaiFixedWithSignature(
              pool0.address,
              poolTokens.toString(),
              '0',
              controllerSig,
              poolSig
            )
            .encodeABI()
          await dsProxy.methods['execute(address,bytes)'](poolProxy.address, calldata, {
            from: user2,
          })
        })

        it('removes liquidity after maturity by redeeming', async () => {
          await helper.advanceTime(31556952)
          await helper.advanceBlock()
          await fyDai0.mature()

          const poolTokens = (await pool0.balanceOf(user2)).toString()

          const calldata = poolProxy.contract.methods
            .removeLiquidityMatureWithSignature(pool0.address, poolTokens.toString(), controllerSig, poolSig)
            .encodeABI()
          await dsProxy.methods['execute(address,bytes)'](poolProxy.address, calldata, {
            from: user2,
          })
        })
      })
    })
  })
})
