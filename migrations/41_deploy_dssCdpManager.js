const fixed_addrs = require('./fixed_addrs.json')

const Migrations = artifacts.require('Migrations')
const Vat = artifacts.require('Vat')
const DssCdpManager = artifacts.require('DssCdpManager')


module.exports = async (deployer, network) => {

  let dssCdpManagerAddress
  if (network === 'development') {
    await deployer.deploy(DssCdpManager, (await Vat.deployed()).address)
    dssCdpManagerAddress = (await DssCdpManager.deployed()).address
  } else {
    dssCdpManagerAddress = fixed_addrs[network].dssCdpManagerAddress
  }

  const deployment = {
    DssCdpManager: dssCdpManagerAddress,
  }

  let migrations
  if (network === 'kovan' && network === 'kovan-fork') {
    migrations = await Migrations.at(fixed_addrs[network].migrationsAddress)
  } else if (network === 'development') {
    migrations = await Migrations.deployed()
  }

  if (migrations !== undefined) {
    for (name in deployment) {
      await migrations.register(web3.utils.fromAscii(name), deployment[name])
    }
  }

  console.log(deployment)
}
