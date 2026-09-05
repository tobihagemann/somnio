/** A source of uniformly distributed 32-bit unsigned integers; injectable so placement is testable. */
export interface RandomSource {
  nextUInt32(): number
}

export const systemRandom: RandomSource = {
  nextUInt32: () => Math.floor(Math.random() * 0x1_0000_0000),
}

/** SplitMix64, so placement tests get reproducible sampling from a seed. */
export function seededRandom(seed: number | bigint): RandomSource {
  let state = BigInt.asUintN(64, BigInt(seed))
  return {
    nextUInt32: () => {
      state = BigInt.asUintN(64, state + 0x9e3779b97f4a7c15n)
      let z = state
      z = BigInt.asUintN(64, (z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n)
      z = BigInt.asUintN(64, (z ^ (z >> 27n)) * 0x94d049bb133111ebn)
      z = z ^ (z >> 31n)
      return Number(z & 0xffffffffn)
    },
  }
}

/** An integer in the inclusive range `[low, high]`; the modulo bias for spans not dividing 2^32 is immaterial for placement. */
export function randomInRange(source: RandomSource, low: number, high: number): number {
  const span = high - low + 1
  return low + (source.nextUInt32() % span)
}
