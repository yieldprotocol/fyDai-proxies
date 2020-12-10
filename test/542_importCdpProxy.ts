const Pool = artifacts.require('Pool')
const ImportCdpProxy = artifacts.require('ImportCdpProxy')
const DSProxy = artifacts.require('DSProxy')
const DSProxyFactory = artifacts.require('DSProxyFactory')
const DSProxyRegistry = artifacts.require('ProxyRegistry')
const DssCdpManager = artifacts.require('DssCdpManager')

import { id } from 'ethers/lib/utils'
import { getSignatureDigest, userPrivateKey, sign } from './shared/signatures'
// @ts-ignore
import { BN, expectRevert } from '@openzeppelin/test-helpers'
import { WETH, rate1, daiTokens1, mulRay, toRay, name, chainId, bnify, MAX, ZERO } from './shared/utils'
import { YieldEnvironmentLite, Contract } from './shared/fixtures'

import { assert, expect } from 'chai'

contract('ImportCdpProxy', async (accounts) => {
  let [owner, user] = accounts

  const fyDaiTokens1 = daiTokens1
  let maturity1: number
  let env: YieldEnvironmentLite
  let dai: Contract
  let vat: Contract
  let cdpMgr: Contract
  let controller: Contract
  let weth: Contract
  let fyDai1: Contract
  let importCdpProxy: Contract
  let pool1: Contract

  let proxyFactory: Contract
  let proxyRegistry: Contract
  let dsProxy: Contract

  let cdp: any
  let urn: any

  const rayTwo = toRay(2)

  beforeEach(async () => {
    const block = await web3.eth.getBlockNumber()
    maturity1 = (await web3.eth.getBlock(block)).timestamp + 30000000 // Far enough so that the extra weth to borrow is above dust

    env = await YieldEnvironmentLite.setup([maturity1])
    controller = env.controller
    vat = env.maker.vat
    dai = env.maker.dai
    weth = env.maker.weth

    fyDai1 = env.fyDais[0]

    // Setup CDP Manager
    cdpMgr = await DssCdpManager.new(vat.address, { from: owner })

    // Setup Pool
    pool1 = await Pool.new(dai.address, fyDai1.address, 'Name', 'Symbol', { from: owner })

    // Setup DSProxyFactory and DSProxyCache
    proxyFactory = await DSProxyFactory.new({ from: owner })

    // Setup DSProxyRegistry
    proxyRegistry = await DSProxyRegistry.new(proxyFactory.address, { from: owner })

    // Setup ImportCdpProxy
    importCdpProxy = await ImportCdpProxy.new(
      controller.address,
      [pool1.address],
      proxyRegistry.address,
      cdpMgr.address,
      { from: owner }
    )

    // Allow owner to mint fyDai the sneaky way, without recording a debt in controller
    await fyDai1.orchestrate(owner, id('mint(address,uint256)'), { from: owner })

    // Initialize Pool1
    const daiReserves = bnify(daiTokens1).mul(5)
    await env.maker.getDai(owner, daiReserves, rate1)
    await dai.approve(pool1.address, daiReserves, { from: owner })
    await pool1.mint(owner, owner, daiReserves, { from: owner })

    // Add fyDai
    const additionalFYDaiReserves = bnify(fyDaiTokens1).mul(2)
    await fyDai1.mint(owner, additionalFYDaiReserves, { from: owner })
    await fyDai1.approve(pool1.address, additionalFYDaiReserves, { from: owner })
    await pool1.sellFYDai(owner, owner, additionalFYDaiReserves, { from: owner })

    // Sets DSProxy for user
    await proxyRegistry.build({ from: user })
    dsProxy = await DSProxy.at(await proxyRegistry.proxies(user))

    // Prime ImportCdpProxy with some Dai to cover rounding losses
    await vat.move(owner, importCdpProxy.address, '2040000000000000000000000000', { from: owner }) // 2.04 wei dai

    // Create a CDP for the user
    await env.maker.getDai(user, daiTokens1, rate1)
    await cdpMgr.open(WETH, user, { from: user })
    cdp = await cdpMgr.cdpi({ from: user }) // We know no one else goes around opening CDPs
    await vat.hope(cdpMgr.address, { from: user })
    await cdpMgr.enter(user, cdp, { from: user })
    urn = await cdpMgr.urns(cdp, { from: user })
    const rad = await vat.dai(user, { from: user })
    await vat.move(user, urn, rad, { from: user }) // cdpMgr.enter leaves fractions of a wei behind :(
  })

  it('does not allow to execute the flash mint callback to users', async () => {
    const data = web3.eth.abi.encodeParameters(
      ['address', 'address', 'uint256', 'uint256', 'uint256'],
      [pool1.address, user, 1, 1, 0]
    )
    await expectRevert(
      importCdpProxy.executeOnFlashMint(1, data, { from: user }),
      'ImportCdpProxy: Callback restricted to the fyDai matching the pool'
    )
  })

  it('does not allow to move more debt than existing in maker', async () => {
    // Give CDP to static ImportCdpProxy
    await cdpMgr.give(cdp, importCdpProxy.address, { from: user })
    const urn = await cdpMgr.urns(cdp)
    const daiDebt = bnify((await vat.urns(WETH, urn)).art).toString()
    const wethCollateral = bnify((await vat.urns(WETH, urn)).ink).toString()

    await expectRevert(
      importCdpProxy.importCdpFromProxy(pool1.address, user, cdp, wethCollateral, bnify(daiDebt).mul(10), rayTwo, {
        from: user,
      }),
      'ImportCdpProxy: Not enough debt in Maker'
    )
  })

  it('does not allow to move more weth than posted in maker', async () => {
    // Give CDP to static ImportCdpProxy
    await cdpMgr.give(cdp, importCdpProxy.address, { from: user })
    const urn = await cdpMgr.urns(cdp)
    const daiDebt = bnify((await vat.urns(WETH, urn)).art).toString()
    const wethCollateral = bnify((await vat.urns(WETH, urn)).ink).toString()

    await expectRevert(
      importCdpProxy.importCdpFromProxy(pool1.address, user, cdp, bnify(wethCollateral).mul(10), daiDebt, rayTwo, {
        from: user,
      }),
      'ImportCdpProxy: Not enough collateral in Maker'
    )
  })

  it('does not allow to migrate if maximum Dai price exceeded', async () => {
    // Give CDP to static ImportCdpProxy
    await cdpMgr.give(cdp, importCdpProxy.address, { from: user })
    const urn = await cdpMgr.urns(cdp)
    const daiDebt = bnify((await vat.urns(WETH, urn)).art).toString()
    const wethCollateral = bnify((await vat.urns(WETH, urn)).ink).toString()

    await expectRevert(
      importCdpProxy.importCdpFromProxy(pool1.address, user, cdp, bnify(wethCollateral).mul(10), daiDebt, toRay(1).toString(), {
        from: user,
      }),
      'ImportCdpProxy: Not enough collateral in Maker'
    )
  })

  it('checks approvals and signatures to move maker vault to yield', async () => {
    let result = await importCdpProxy.importCdpPositionCheck(cdp, { from: user })
    assert.equal(result[0], false)
    assert.equal(result[1], false)

    await cdpMgr.cdpAllow(cdp, importCdpProxy.address, 1, { from: user }) // Usually the cdpAllow would be for dsproxy
    result = await importCdpProxy.importCdpPositionCheck(cdp, { from: user })
    assert.equal(result[0], true)
    assert.equal(result[1], false)

    await controller.addDelegate(importCdpProxy.address, { from: user }) // Allowing ImportCdpProxy to create debt for use in Yield
    result = await importCdpProxy.importCdpPositionCheck(cdp, { from: user })
    assert.equal(result[0], true)
    assert.equal(result[1], true)
  })

  it('moves maker cdp to yield from proxy', async () => {
    const daiDebt = bnify((await vat.urns(WETH, urn)).art).toString()
    const wethCollateral = bnify((await vat.urns(WETH, urn)).ink).toString()

    expect(daiDebt).to.be.bignumber.gt(ZERO)
    expect(wethCollateral).to.be.bignumber.gt(ZERO)

    const daiMaker = mulRay(daiDebt, rate1).toString()
    const fyDaiDebt = (await pool1.buyDaiPreview(daiMaker)).toString()

    // Add permissions for vault migration
    await controller.addDelegate(importCdpProxy.address, { from: user }) // Allowing ImportCdpProxy to create debt for use in Yield

    // Give CDP to static ImportCdpProxy
    await cdpMgr.give(cdp, importCdpProxy.address, { from: user })

    await importCdpProxy.importCdpFromProxy(pool1.address, user, cdp, wethCollateral, daiDebt, rayTwo, { from: user })

    assert.equal(await fyDai1.balanceOf(importCdpProxy.address), 0)
    assert.equal(await dai.balanceOf(importCdpProxy.address), 0)
    assert.equal(await weth.balanceOf(importCdpProxy.address), 0)
    assert.equal((await vat.urns(WETH, user)).ink, 0)
    assert.equal((await vat.urns(WETH, user)).art, 0)
    assert.equal((await controller.posted(WETH, user)).toString(), wethCollateral.toString())
    const obtainedFYDaiDebt = (await controller.debtFYDai(WETH, maturity1, user)).toString()
    expect(obtainedFYDaiDebt).to.be.bignumber.gt(new BN(fyDaiDebt).mul(new BN('9999')).div(new BN('10000')))
    expect(obtainedFYDaiDebt).to.be.bignumber.lt(new BN(fyDaiDebt).mul(new BN('10000')).div(new BN('9999')))
  })

  it('moves maker cdp to yield', async () => {
    const daiDebt = bnify((await vat.urns(WETH, urn)).art).toString()
    const wethCollateral = bnify((await vat.urns(WETH, urn)).ink).toString()

    expect(daiDebt).to.be.bignumber.gt(ZERO)
    expect(wethCollateral).to.be.bignumber.gt(ZERO)

    const daiMaker = mulRay(daiDebt, rate1).toString()
    const fyDaiDebt = (await pool1.buyDaiPreview(daiMaker)).toString()

    // Add permissions for vault migration
    await controller.addDelegate(importCdpProxy.address, { from: user }) // Allowing ImportCdpProxy to create debt for use in Yield
    await cdpMgr.cdpAllow(cdp, dsProxy.address, 1, { from: user }) // Allowing ImportCdpProxy to manipulate the user's cdps

    // Go!!!
    const calldata = importCdpProxy.contract.methods
      .importCdpPosition(pool1.address, cdp.toString(), wethCollateral, daiDebt, rayTwo)
      .encodeABI()
    await dsProxy.methods['execute(address,bytes)'](importCdpProxy.address, calldata, {
      from: user,
    })

    assert.equal(await fyDai1.balanceOf(importCdpProxy.address), 0)
    assert.equal(await dai.balanceOf(importCdpProxy.address), 0)
    assert.equal(await weth.balanceOf(importCdpProxy.address), 0)
    assert.equal((await vat.urns(WETH, user)).ink, 0)
    assert.equal((await vat.urns(WETH, user)).art, 0)
    assert.equal((await controller.posted(WETH, user)).toString(), wethCollateral.toString())
    const obtainedFYDaiDebt = (await controller.debtFYDai(WETH, maturity1, user)).toString()
    expect(obtainedFYDaiDebt).to.be.bignumber.gt(new BN(fyDaiDebt).mul(new BN('9999')).div(new BN('10000')))
    expect(obtainedFYDaiDebt).to.be.bignumber.lt(new BN(fyDaiDebt).mul(new BN('10000')).div(new BN('9999')))
  })

  it('moves half of a maker cdp to yield', async () => {
    const daiDebt = bnify((await vat.urns(WETH, urn)).art).toString()
    const wethCollateral = bnify((await vat.urns(WETH, urn)).ink).toString()

    expect(daiDebt).to.be.bignumber.gt(ZERO)
    expect(wethCollateral).to.be.bignumber.gt(ZERO)

    const daiMaker = mulRay(daiDebt, rate1).toString()

    // Add permissions for vault migration
    await controller.addDelegate(importCdpProxy.address, { from: user }) // Allowing ImportCdpProxy to create debt for use in Yield
    await cdpMgr.cdpAllow(cdp, dsProxy.address, 1, { from: user }) // Allowing ImportCdpProxy to manipulate the user's cdps

    // Move just half of the CDP
    const wethToMove = new BN(wethCollateral).div(new BN('2')).toString()
    const debtToMove = new BN(daiDebt).div(new BN('2')).toString()
    const fyDaiDebt = (await pool1.buyDaiPreview(new BN(daiMaker).div(new BN('2')))).toString()

    // Go!!!
    const calldata = importCdpProxy.contract.methods
      .importCdpPosition(pool1.address, cdp.toString(), wethToMove, debtToMove, rayTwo)
      .encodeABI()
    await dsProxy.methods['execute(address,bytes)'](importCdpProxy.address, calldata, {
      from: user,
    })

    assert.equal(await fyDai1.balanceOf(importCdpProxy.address), 0)
    assert.equal(await dai.balanceOf(importCdpProxy.address), 0)
    assert.equal(await weth.balanceOf(importCdpProxy.address), 0)
    assert.equal((await vat.urns(WETH, urn)).ink, wethToMove)
    assert.equal((await vat.urns(WETH, urn)).art, debtToMove)
    assert.equal((await controller.posted(WETH, user)).toString(), wethToMove)
    assert.equal(await cdpMgr.owns(cdp), user)
    const obtainedFYDaiDebt = (await controller.debtFYDai(WETH, maturity1, user)).toString()
    expect(obtainedFYDaiDebt).to.be.bignumber.gt(new BN(fyDaiDebt).mul(new BN('9999')).div(new BN('10000')))
    expect(obtainedFYDaiDebt).to.be.bignumber.lt(new BN(fyDaiDebt).mul(new BN('10000')).div(new BN('9999')))
  })

  it('moves maker cdp to yield with signature', async () => {
    const daiDebt = bnify((await vat.urns(WETH, urn)).art).toString()
    const wethCollateral = bnify((await vat.urns(WETH, urn)).ink).toString()
    expect(daiDebt).to.be.bignumber.gt(ZERO)
    expect(wethCollateral).to.be.bignumber.gt(ZERO)

    // Authorize the proxy for the controller
    const controllerDigest = getSignatureDigest(
      name,
      controller.address,
      chainId,
      {
        user: user,
        delegate: importCdpProxy.address,
      },
      (await controller.signatureCount(user)).toString(),
      MAX
    )
    const controllerSig = sign(controllerDigest, userPrivateKey)

    await cdpMgr.cdpAllow(cdp, dsProxy.address, 1, { from: user }) // Allowing ImportCdpProxy to manipulate the user's cdps

    // Go!!!
    const calldata = importCdpProxy.contract.methods
      .importCdpPositionWithSignature(pool1.address, cdp.toString(), wethCollateral, daiDebt, rayTwo, controllerSig)
      .encodeABI()
    await dsProxy.methods['execute(address,bytes)'](importCdpProxy.address, calldata, {
      from: user,
    })
  })

  it('cdp migration is restricted to cdp owners or their proxies', async () => {
    await expectRevert(
      importCdpProxy.importCdpPosition(pool1.address, 1, 1, 1, rayTwo, { from: owner }),
      'ImportCdpProxy: Restricted to user or its dsproxy'
    )
  })

  it('importCdpFromProxy is restricted to cdp owners or their proxies', async () => {
    await expectRevert(
      importCdpProxy.importCdpFromProxy(pool1.address, user, 1, 1, 1, rayTwo, { from: owner }),
      'ImportCdpProxy: Restricted to user or its dsproxy'
    )
  })
})
