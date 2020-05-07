import { replaceHint } from '@cryptoeconomicslab/db'
import {
  BigNumber,
  Address,
  Range,
  Bytes
} from '@cryptoeconomicslab/primitives'

export const createInclusionProofHint = (
  blockNumber: BigNumber,
  depositContractAddress: Address,
  range: Range
) => {
  const { coder } = ovmContext
  return replaceHint('proof.block${b}.range${token},RANGE,${range}', {
    b: coder.encode(blockNumber),
    token: coder.encode(depositContractAddress),
    range: coder.encode(range.toStruct())
  })
}

export const createTxHint = (
  blockNumber: BigNumber,
  depositContractAddress: Address,
  range: Range
) => {
  const { coder } = ovmContext
  return replaceHint('tx.block${b}.range${token},RANGE,${range}', {
    b: coder.encode(blockNumber),
    token: coder.encode(depositContractAddress),
    range: coder.encode(range.toStruct())
  })
}

export const createSignatureHint = (message: Bytes) => {
  return replaceHint('signatures,KEY,${m}', {
    m: message
  })
}
