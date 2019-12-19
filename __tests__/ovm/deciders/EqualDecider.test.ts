import { BigNumber } from '../../../src/types'
import Coder from '../../../src/coder'
import { EqualDecider } from '../../../src/ovm'
import { MockDeciderManager } from '../mocks/MockDeciderManager'

describe('EqualDecider', () => {
  const decider = new EqualDecider()
  const deciderManager = new MockDeciderManager()

  test('decide true', async () => {
    const decision = await decider.decide(deciderManager, [
      Coder.encode(BigNumber.from(10)),
      Coder.encode(BigNumber.from(10))
    ])

    expect(decision.outcome).toBeTruthy()
  })

  test('decide false', async () => {
    const decision = await decider.decide(deciderManager, [
      Coder.encode(BigNumber.from(1)),
      Coder.encode(BigNumber.from(10))
    ])

    expect(decision.outcome).toBeFalsy()
  })
})