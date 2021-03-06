import DepositedRangeManager from '../src/managers/DepositedRangeManager'
import { setupContext } from '@cryptoeconomicslab/context'
import JsonCoder from '@cryptoeconomicslab/coder'
import { RangeDb, RangeRecord, KeyValueStore } from '@cryptoeconomicslab/db'
import { IndexedDbKeyValueStore } from '@cryptoeconomicslab/indexeddb-kvs'
import {
  Bytes,
  Address,
  Range,
  BigNumber
} from '@cryptoeconomicslab/primitives'
import 'fake-indexeddb/auto'
import JSBI from '@cryptoeconomicslab/primitives/node_modules/jsbi'
setupContext({ coder: JsonCoder })

describe('DepositedRangeManager', () => {
  let depositedRangeManager: DepositedRangeManager
  let db: RangeDb

  async function clearDb(kvs: KeyValueStore) {
    await new Promise(resolve => {
      const req = indexedDB.deleteDatabase('depositedRange')
      req.onblocked = () => {
        console.log('blocked')
      }
      req.onsuccess = () => {
        resolve()
      }
    })
  }

  beforeEach(async () => {
    db = new RangeDb(
      new IndexedDbKeyValueStore(Bytes.fromString('depositedRange'))
    )
    depositedRangeManager = new DepositedRangeManager(db)
  })

  afterEach(async () => {
    await clearDb(db.kvs)
  })

  test('extendRange successfully save range into appropriate bucket for the initial insertion', async () => {
    await depositedRangeManager.extendRange(
      Address.default(),
      new Range(BigNumber.from(0), BigNumber.from(100))
    )
    const bucket = await depositedRangeManager['getBucket'](Address.default())
    const ranges = await bucket.get(JSBI.BigInt(0), JSBI.BigInt(100))
    expect(ranges).toStrictEqual([
      new RangeRecord(
        BigNumber.from(0),
        BigNumber.from(100),
        JsonCoder.encode(BigNumber.from(100))
      )
    ])
  })

  test('extendRange successfully override range', async () => {
    await depositedRangeManager.extendRange(
      Address.default(),
      new Range(BigNumber.from(0), BigNumber.from(40))
    )
    await depositedRangeManager.extendRange(
      Address.default(),
      new Range(BigNumber.from(0), BigNumber.from(100))
    )
    const bucket = await depositedRangeManager['getBucket'](Address.default())
    const ranges = await bucket.get(JSBI.BigInt(0), JSBI.BigInt(100))
    expect(ranges).toStrictEqual([
      new RangeRecord(
        BigNumber.from(0),
        BigNumber.from(100),
        JsonCoder.encode(BigNumber.from(100))
      )
    ])
  })

  test('removeRange successfully remove range from depositedRange', async () => {
    await depositedRangeManager.extendRange(
      Address.default(),
      new Range(BigNumber.from(0), BigNumber.from(100))
    )
    await depositedRangeManager.removeRange(
      Address.default(),
      new Range(BigNumber.from(30), BigNumber.from(40))
    )
    const bucket = await depositedRangeManager['getBucket'](Address.default())
    const ranges = await bucket.get(JSBI.BigInt(0), JSBI.BigInt(100))
    expect(ranges).toStrictEqual([
      new RangeRecord(
        BigNumber.from(0),
        BigNumber.from(30),
        JsonCoder.encode(BigNumber.from(30))
      ),
      new RangeRecord(
        BigNumber.from(40),
        BigNumber.from(100),
        JsonCoder.encode(BigNumber.from(100))
      )
    ])
  })

  test('removeRange completely', async () => {
    await depositedRangeManager.extendRange(
      Address.default(),
      new Range(BigNumber.from(0), BigNumber.from(100))
    )
    await depositedRangeManager.removeRange(
      Address.default(),
      new Range(BigNumber.from(0), BigNumber.from(50))
    )
    await depositedRangeManager.removeRange(
      Address.default(),
      new Range(BigNumber.from(50), BigNumber.from(100))
    )
    const bucket = await depositedRangeManager['getBucket'](Address.default())
    const ranges = await bucket.get(JSBI.BigInt(0), JSBI.BigInt(1000))
    expect(ranges).toStrictEqual([])
  })

  test('getDepositedRangeId', async () => {
    await depositedRangeManager.extendRange(
      Address.default(),
      new Range(BigNumber.from(0), BigNumber.from(100))
    )
    const depositedRangeId = await depositedRangeManager.getDepositedRangeId(
      Address.default(),
      new Range(BigNumber.from(7), BigNumber.from(20))
    )
    expect(depositedRangeId).toStrictEqual(BigNumber.from(100))
  })

  test('fail to getDepositedRangeId with multiple ranges detected', async () => {
    await depositedRangeManager.extendRange(
      Address.default(),
      new Range(BigNumber.from(0), BigNumber.from(100))
    )
    await depositedRangeManager.removeRange(
      Address.default(),
      new Range(BigNumber.from(40), BigNumber.from(50))
    )
    await expect(
      depositedRangeManager.getDepositedRangeId(
        Address.default(),
        new Range(BigNumber.from(35), BigNumber.from(55))
      )
    ).rejects.toEqual(new Error('Multiple ranges detected'))
  })

  test('fail to getDepositedRangeId with no range detected', async () => {
    await expect(
      depositedRangeManager.getDepositedRangeId(
        Address.default(),
        new Range(BigNumber.from(0), BigNumber.from(5))
      )
    ).rejects.toEqual(new Error('No range detected'))
  })
})
