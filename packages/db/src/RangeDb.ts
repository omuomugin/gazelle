import { Bytes } from '@cryptoeconomicslab/primitives'
import {
  RangeStore,
  RangeRecord as Range,
  RangeIterator as RangeIter
} from './RangeStore'
import {
  BatchOperation,
  KeyValueStore,
  Iterator as KVSIter
} from './KeyValueStore'
import JSBI from 'jsbi'

/**
 * RangeIterator
 * iterator to return values between lowerBound as start to upperBound as end.
 */
class RangeIterator implements RangeIter {
  private kvsIter: KVSIter
  constructor(
    readonly rangeDb: RangeDb,
    readonly lowerBound: JSBI,
    readonly upperBound?: JSBI
  ) {
    this.kvsIter = rangeDb.kvs.iter(RangeDb.createKey(lowerBound), true)
  }

  public async next(): Promise<Range | null> {
    const keyValue = await this.kvsIter.next()
    if (!keyValue) return null
    const d = Range.decode(keyValue.value)
    if (this.upperBound && JSBI.greaterThan(d.end.data, this.upperBound))
      return null
    return d
  }
}

export class RangeDb implements RangeStore {
  public kvs: KeyValueStore
  constructor(kvs: KeyValueStore) {
    this.kvs = kvs
  }

  /**
   * key is 32 bytes padded bytes
   * @param start is source of key
   */
  static createKey(start: JSBI) {
    return Bytes.fromHexString(start.toString(16)).padZero(32)
  }

  public async get(start: JSBI, end: JSBI): Promise<Range[]> {
    const iter = this.kvs.iter(RangeDb.createKey(start), true)
    const keyValue = await iter.next()
    if (keyValue === null) {
      return []
    }

    const ranges: Range[] = []
    let range = Range.decode(keyValue.value)
    while (range.intersect(start, end)) {
      ranges.push(range)
      const keyValue = await iter.next()
      if (keyValue === null) {
        break
      }
      range = Range.decode(keyValue.value)
    }
    return ranges
  }

  public async put(start: JSBI, end: JSBI, value: Bytes): Promise<void> {
    const inputRanges = await this.delBatch(start, end)
    const outputRanges: Range[] = []
    if (
      inputRanges.length > 0 &&
      JSBI.lessThan(inputRanges[0].start.data, start)
    ) {
      outputRanges.push(
        new Range(inputRanges[0].start, start, inputRanges[0].value)
      )
    }
    if (inputRanges.length > 0) {
      const lastRange = inputRanges[inputRanges.length - 1]
      if (JSBI.lessThan(end, lastRange.end.data)) {
        outputRanges.push(new Range(end, lastRange.end, lastRange.value))
      }
    }
    outputRanges.push(new Range(start, end, value))
    return this.putBatch(outputRanges)
  }

  public async del(start: JSBI, end: JSBI): Promise<void> {
    await this.delBatch(start, end)
    return
  }

  public async bucket(key: Bytes): Promise<RangeStore> {
    const db = await this.kvs.bucket(key)
    return new RangeDb(db)
  }

  public iter(lowerBound: JSBI, upperBound?: JSBI): RangeIterator {
    return new RangeIterator(this, lowerBound, upperBound)
  }

  private async delBatch(start: JSBI, end: JSBI): Promise<Range[]> {
    const ranges = await this.get(start, end)
    const ops: BatchOperation[] = ranges.map(r => {
      return {
        type: 'Del',
        key: RangeDb.createKey(r.end.data)
      }
    })
    await this.kvs.batch(ops)
    return ranges
  }

  private async putBatch(ranges: Range[]): Promise<void> {
    const ops: BatchOperation[] = ranges.map(r => {
      return {
        type: 'Put',
        key: RangeDb.createKey(r.end.data),
        value: r.encode()
      }
    })
    return this.kvs.batch(ops)
  }
}
