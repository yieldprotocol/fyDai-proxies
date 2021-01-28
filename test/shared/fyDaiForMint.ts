import { buyFYDai } from './yieldspace'

const { bignumber, add, subtract, multiply, divide, floor } = require('mathjs')

export function fyDaiForMint(
  daiReserves: any,
  fyDaiRealReserves: any,
  fyDaiVirtualReserves: any,
  dai: any,
  timeTillMaturity: any
): any {
  const Z = bignumber(daiReserves)
  const YR = bignumber(fyDaiRealReserves)
  const YV = bignumber(fyDaiVirtualReserves)
  const z = bignumber(dai)
  const t = bignumber(timeTillMaturity)

  let min = bignumber(0)
  let max = z
  let y_out = divide(add(min, max), bignumber(2)) // average

  let i = 0
  while (true) {
    const z_in = bignumber(buyFYDai(Z, YV, y_out, t))
    const Z_1 = add(Z, z_in) // New dai reserves
    const Y_1 = subtract(YR, y_out) // New fyDai reserves

    const pz = divide(subtract(z, z_in), add(subtract(z, z_in), y_out)) // dai proportion in my assets
    const PZ = divide(Z_1, add(Z_1, Y_1)) // dai proportion in the reserves
    // console.log(`i = ${i}`)
    // console.log(`pz = ${pz}`)
    // console.log(`PZ = ${PZ}`)

    // The dai proportion in my assets needs to be higher than but very close to the dai proportion in the reserves, to make sure all the fyDai is used.
    if (multiply(PZ, bignumber(1.000001)) <= pz) min = y_out
    y_out = divide(add(y_out, max), bignumber(2)) // bought too little fyDai, buy some more
    if (pz <= PZ) max = y_out
    y_out = divide(add(y_out, min), bignumber(2)) // bought too much fyDai, buy a bit less
    // console.log(`y = ${floor(y_out).toFixed()}\n`)

    if (multiply(PZ, bignumber(1.000001)) > pz && pz > PZ) return floor(y_out).toFixed() // Just right

    if (i++ > 10000) return floor(y_out).toFixed()
  }
}
