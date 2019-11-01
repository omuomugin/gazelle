import { Bytes } from '../../types/Codables'
import { Decision } from '../types'
import { DeciderManager } from '../DeciderManager'

export interface Decider {
  decide(manager: DeciderManager, inputs: Bytes[]): Promise<Decision>
}
