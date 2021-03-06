import {
  BigNumber,
  Bytes,
  Struct,
  List,
  FixedBytes
} from '@cryptoeconomicslab/primitives'
import { Property } from '@cryptoeconomicslab/ovm'
import { Keccak256 } from '@cryptoeconomicslab/hash'
import {
  DoubleLayerTree,
  DoubleLayerTreeLeaf,
  DoubleLayerInclusionProof,
  DoubleLayerTreeVerifier
} from '@cryptoeconomicslab/merkle-tree'

import StateUpdate from './StateUpdate'

export default class Block {
  private static StateUpdate = StateUpdate
  private tree: DoubleLayerTree | null = null

  constructor(
    readonly blockNumber: BigNumber,
    readonly stateUpdatesMap: Map<string, StateUpdate[]>
  ) {}

  public getTree(): DoubleLayerTree {
    if (this.tree) return this.tree

    this.tree = this.generateTree()
    return this.tree
  }

  private generateLeaf(stateUpdate: StateUpdate) {
    return new DoubleLayerTreeLeaf(
      stateUpdate.depositContractAddress,
      stateUpdate.range.start,
      FixedBytes.from(
        32,
        Keccak256.hash(
          ovmContext.coder.encode(stateUpdate.stateObject.toStruct())
        ).data
      )
    )
  }

  private generateTree(): DoubleLayerTree {
    let stateUpdates: StateUpdate[] = []
    this.stateUpdatesMap.forEach(v => {
      stateUpdates = [...stateUpdates, ...v]
    })
    const leaves = stateUpdates.map(this.generateLeaf)
    return new DoubleLayerTree(leaves)
  }

  public verifyInclusion(
    stateUpdate: StateUpdate,
    inclusionProof: DoubleLayerInclusionProof
  ): boolean {
    const tree = this.getTree()
    const leaf = this.generateLeaf(stateUpdate)
    if (tree.findIndex(leaf.data) === null) {
      return false
    }
    const verifier = new DoubleLayerTreeVerifier()
    return verifier.verifyInclusion(
      leaf,
      stateUpdate.range,
      tree.getRoot(),
      inclusionProof
    )
  }

  public getInclusionProof(
    stateUpdate: StateUpdate
  ): DoubleLayerInclusionProof | null {
    const leaf = this.generateLeaf(stateUpdate)
    const tree = this.getTree()
    const i = tree.findIndex(leaf.data)
    if (i === null) return null

    const proof = tree.getInclusionProofByAddressAndIndex(
      stateUpdate.depositContractAddress,
      i
    )

    return proof
  }

  public static fromStruct(s: Struct) {
    const map = new Map()
    const blockNumber = s.data[0].value as BigNumber
    const tokenAddresses = s.data[1].value as List<Bytes>
    const stateUpdatesList = s.data[2].value as List<List<Struct>>
    tokenAddresses.data.forEach((b: Bytes, i: number) => {
      const key = b.toHexString()
      map.set(
        key,
        stateUpdatesList.data[i].data.map((s: Struct) =>
          this.StateUpdate.fromProperty(Property.fromStruct(s))
        )
      )
    })
    return new this(blockNumber, map)
  }

  public toStruct(): Struct {
    const addrs = Array.from(this.stateUpdatesMap.keys())

    const stateUpdatesList = addrs.map(addr => {
      const stateUpdates = this.stateUpdatesMap.get(addr) || []
      const list = stateUpdates.map(s => s.property.toStruct())
      return List.from(
        {
          default: Property.getParamType
        },
        list
      )
    })

    return new Struct([
      {
        key: 'blockNumber',
        value: this.blockNumber
      },
      {
        key: 'tokenAddresses',
        value: List.from(Bytes, addrs.map(Bytes.fromHexString))
      },
      {
        key: 'stateUpdatesList',
        value: List.from(
          {
            default: () =>
              List.default(
                {
                  default: Property.getParamType
                },
                Property.getParamType()
              )
          },
          stateUpdatesList
        )
      }
    ])
  }

  public static getParamType(): Struct {
    return new Struct([
      {
        key: 'blockNumber',
        value: BigNumber.default()
      },
      { key: 'tokenAddresses', value: List.default(Bytes, Bytes.default()) },
      {
        key: 'stateUpdatesList',
        value: List.default(
          {
            default: () =>
              List.default(
                {
                  default: Property.getParamType
                },
                Property.getParamType()
              )
          },
          List.from({ default: Property.getParamType }, [])
        )
      }
    ])
  }
}
