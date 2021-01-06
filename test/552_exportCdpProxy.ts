const Pool = artifacts.require('Pool')
const ExportCdpProxy = artifacts.require('ExportCdpProxy')
const DssCdpManager = artifacts.require('DssCdpManager')

import { id } from 'ethers/lib/utils'
import { getSignatureDigest, userPrivateKey, sign } from './shared/signatures'
// @ts-ignore
import { BN, expectRevert } from '@openzeppelin/test-helpers'
import { WETH, rate1, wethTokens1, daiTokens1, mulRay, toRay, name, chainId, bnify, MAX } from './shared/utils'
import { YieldEnvironmentLite, Contract } from './shared/fixtures'

import { assert, expect } from 'chai'

contract('ExportCdpProxy', async (accounts) => {
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
  let exportCdpProxy: Contract
  let pool1: Contract

  let cdp: any
  let urn: any

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

    // Setup ExportCdpProxy
    exportCdpProxy = await ExportCdpProxy.new(
      controller.address,
      [pool1.address],
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

    // Create an empty CDP for the user
    await cdpMgr.open(WETH, user, { from: user })
    cdp = await cdpMgr.cdpi({ from: user }) // We know no one else goes around opening CDPs
    await vat.hope(cdpMgr.address, { from: user })
    await cdpMgr.enter(user, cdp, { from: user })
    urn = await cdpMgr.urns(cdp, { from: user })

    // Allow ExportCdpProxy to manipulate the cdp in MakerDAO
    await cdpMgr.cdpAllow(cdp, exportCdpProxy.address, 1, { from: user }) 
  })

  it('does not allow to execute the flash mint callback to users', async () => {
    const data = web3.eth.abi.encodeParameters(
      ['address', 'address', 'uint256', 'uint256', 'uint256'],
      [pool1.address, user, cdp.toNumber(), 1, 0]
    )
    await expectRevert(exportCdpProxy.executeOnFlashMint(1, data, { from: user }), 'ExportCdpProxy: Restricted callback')
  })

  it('does not allow to export to cdp not owned by the user', async () => {
    await env.postWeth(user, wethTokens1)
    const toBorrow = (await env.unlockedOf(WETH, user)).toString()
    await controller.borrow(WETH, maturity1, user, user, toBorrow, { from: user })

    await expectRevert(
      exportCdpProxy.exportCdpPosition(pool1.address, 2, bnify(wethTokens1).mul(2), toBorrow, toRay(1), { from: user }),
      'ExportCdpProxy: User doesn\'t have rights to the target cdp'
    )
  })

  it('does not allow to move more debt than existing in env', async () => {
    await expectRevert(
      exportCdpProxy.exportCdpPosition(pool1.address, cdp, wethTokens1, fyDaiTokens1, toRay(1), { from: user }),
      'ExportCdpProxy: Not enough debt in Yield'
    )
  })

  it('does not allow to move more weth than posted in env', async () => {
    await env.postWeth(user, wethTokens1)
    const toBorrow = (await env.unlockedOf(WETH, user)).toString()
    await controller.borrow(WETH, maturity1, user, user, toBorrow, { from: user })

    await expectRevert(
      exportCdpProxy.exportCdpPosition(pool1.address, cdp, bnify(wethTokens1).mul(2), toBorrow, toRay(1), { from: user }),
      'ExportCdpProxy: Not enough collateral in Yield'
    )
  })

  it('does not allow to migrate if maximum fyDai price exceeded', async () => {
    await env.postWeth(user, wethTokens1)
    const toBorrow = (await env.unlockedOf(WETH, user)).toString()
    await controller.borrow(WETH, maturity1, user, user, toBorrow, { from: user })

    await expectRevert(
      exportCdpProxy.exportCdpPosition(pool1.address, cdp, wethTokens1, toBorrow, toRay(0.5), { from: user }),
      'ExportCdpProxy: Maximum fyDai price exceeded'
    )
  })

  it('moves yield vault to maker', async () => {
    await env.postWeth(user, wethTokens1)
    const toBorrow = (await env.unlockedOf(WETH, user)).toString()
    await controller.borrow(WETH, maturity1, user, user, toBorrow, { from: user })

    // Add permissions for vault migration
    await controller.addDelegate(exportCdpProxy.address, { from: user }) // Allowing ExportCdpProxy to create debt for use in Yield

    // Go!!!
    assert.equal((await controller.posted(WETH, user)).toString(), wethTokens1)
    assert.equal((await controller.debtFYDai(WETH, maturity1, user)).toString(), toBorrow.toString())
    assert.equal((await vat.urns(WETH, user)).ink, 0)
    assert.equal((await vat.urns(WETH, user)).art, 0)
    assert.equal(await fyDai1.balanceOf(exportCdpProxy.address), 0)

    // Will need this one for testing. As time passes, even for one block, the resulting dai debt will be higher than this value
    const makerDebtEstimate = await pool1.buyFYDaiPreview(toBorrow)

    await exportCdpProxy.exportCdpPosition(pool1.address, cdp, wethTokens1, toBorrow, toRay(1), { from: user })

    assert.equal(await fyDai1.balanceOf(exportCdpProxy.address), 0)
    assert.equal(await dai.balanceOf(exportCdpProxy.address), 0)
    assert.equal(await weth.balanceOf(exportCdpProxy.address), 0)
    assert.equal((await controller.posted(WETH, user)).toString(), 0)
    assert.equal((await controller.debtFYDai(WETH, maturity1, user)).toString(), 0)
    assert.equal((await vat.urns(WETH, urn)).ink, wethTokens1)
    const makerDebt = mulRay((await vat.urns(WETH, urn)).art.toString(), rate1).toString()
    expect(makerDebt).to.be.bignumber.gt(makerDebtEstimate)
    expect(makerDebt).to.be.bignumber.lt(makerDebtEstimate.mul(new BN('10001')).div(new BN('10000')))
  })

  it('moves yield vault to maker with a signature', async () => {
    await env.postWeth(user, wethTokens1)
    const toBorrow = (await env.unlockedOf(WETH, user)).toString()
    await controller.borrow(WETH, maturity1, user, user, toBorrow, { from: user })

    // Add permissions for vault migration

    // Authorize the proxy for the controller
    const controllerDigest = getSignatureDigest(
      name,
      controller.address,
      chainId,
      {
        user: user,
        delegate: exportCdpProxy.address,
      },
      (await controller.signatureCount(user)).toString(),
      MAX
    )
    const controllerSig = sign(controllerDigest, userPrivateKey)

    await exportCdpProxy.exportCdpPositionWithSignature(pool1.address, cdp, wethTokens1, toBorrow, toRay(1), controllerSig, { from: user })
  })
})
