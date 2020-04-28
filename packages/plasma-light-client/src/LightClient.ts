import {
  StateUpdate,
  Transaction,
  TransactionReceipt,
  Checkpoint,
  IExit,
  Exit,
  ExitDeposit,
  PlasmaContractConfig
} from '@cryptoeconomicslab/plasma'
import {
  Property,
  CompiledPredicate,
  DeciderManager,
  DeciderConfig,
  Challenge
} from '@cryptoeconomicslab/ovm'
import {
  Address,
  Bytes,
  FixedBytes,
  BigNumber,
  Range,
  List
} from '@cryptoeconomicslab/primitives'
import {
  KeyValueStore,
  RangeDb,
  getWitnesses,
  putWitness,
  RangeStore
} from '@cryptoeconomicslab/db'
import {
  ICommitmentContract,
  IDepositContract,
  IERC20Contract,
  IERC20DetailedContract,
  IAdjudicationContract,
  IOwnershipPayoutContract
} from '@cryptoeconomicslab/contract'
import { Wallet } from '@cryptoeconomicslab/wallet'
import { decodeStructable } from '@cryptoeconomicslab/coder'
import {
  DoubleLayerInclusionProof,
  DoubleLayerTreeVerifier,
  DoubleLayerTreeLeaf
} from '@cryptoeconomicslab/merkle-tree'
import { Keccak256 } from '@cryptoeconomicslab/hash'
import JSBI from 'jsbi'
import { createInclusionProofHint } from './hintString'
import UserAction, {
  createDepositUserAction,
  createExitUserAction,
  createReceiveUserAction,
  createSendUserAction
} from './UserAction'

import EventEmitter from 'event-emitter'
import {
  StateManager,
  SyncManager,
  CheckpointManager,
  DepositedRangeManager
} from './managers'
import APIClient from './APIClient'
import TokenManager from './managers/TokenManager'
import { executeChallenge } from './helper/challenge'

enum EmitterEvent {
  CHECKPOINT_FINALIZED = 'CHECKPOINT_FINALIZED',
  TRANSFER_COMPLETE = 'TRANSFER_COMPLETE',
  SYNC_FINISHED = 'SYNC_FINISHED',
  EXIT_FINALIZED = 'EXIT_FINALIZED'
}

interface LightClientOptions {
  wallet: Wallet
  witnessDb: KeyValueStore
  adjudicationContract: IAdjudicationContract
  depositContractFactory: (address: Address) => IDepositContract
  tokenContractFactory: (address: Address) => IERC20DetailedContract
  commitmentContract: ICommitmentContract
  ownershipPayoutContract: IOwnershipPayoutContract
  deciderConfig: DeciderConfig & PlasmaContractConfig
  aggregatorEndpoint?: string
}

export default class LightClient {
  private depositContracts: Map<string, IDepositContract> = new Map()
  private _syncing = false
  private ee = EventEmitter()
  private ownershipPredicate: CompiledPredicate
  private deciderManager: DeciderManager
  private apiClient: APIClient
  private tokenManager: TokenManager

  constructor(
    private wallet: Wallet,
    private witnessDb: KeyValueStore,
    private adjudicationContract: IAdjudicationContract,
    private depositContractFactory: (address: Address) => IDepositContract,
    private tokenContractFactory: (address: Address) => IERC20DetailedContract,
    private commitmentContract: ICommitmentContract,
    private ownershipPayoutContract: IOwnershipPayoutContract,
    private stateManager: StateManager,
    private syncManager: SyncManager,
    private checkpointManager: CheckpointManager,
    private depositedRangeManager: DepositedRangeManager,
    deciderConfig: DeciderConfig,
    private aggregatorEndpoint: string = 'http://localhost:3000'
  ) {
    this.deciderManager = new DeciderManager(witnessDb, ovmContext.coder)
    this.deciderManager.loadJson(deciderConfig)
    const ownershipPredicate = this.deciderManager.compiledPredicateMap.get(
      'Ownership'
    )
    if (ownershipPredicate === undefined) {
      throw new Error('Ownership not found')
    }
    this.ownershipPredicate = ownershipPredicate
    this.apiClient = new APIClient(this.aggregatorEndpoint)
    this.tokenManager = new TokenManager()
  }

  /**
   * Initialize Plasma Light Client by options
   * @param options LightClientOptions to instantiate LightClient
   */
  static async initilize(options: LightClientOptions): Promise<LightClient> {
    const witnessDb = options.witnessDb
    const stateDb = await witnessDb.bucket(Bytes.fromString('state'))
    const syncDb = await witnessDb.bucket(Bytes.fromString('sync'))
    const checkpointDb = await witnessDb.bucket(Bytes.fromString('checkpoint'))
    const depositedRangeDb = await witnessDb.bucket(
      Bytes.fromString('depositedRange')
    )
    const client = new LightClient(
      options.wallet,
      options.witnessDb,
      options.adjudicationContract,
      options.depositContractFactory,
      options.tokenContractFactory,
      options.commitmentContract,
      options.ownershipPayoutContract,
      new StateManager(stateDb),
      new SyncManager(syncDb),
      new CheckpointManager(checkpointDb),
      new DepositedRangeManager(new RangeDb(depositedRangeDb)),
      options.deciderConfig,
      options.aggregatorEndpoint
    )
    await client.start()
    return client
  }

  public ownershipProperty(owner: Address): Property {
    return this.ownershipPredicate.makeProperty([
      ovmContext.coder.encode(owner)
    ])
  }

  public getOwner(stateUpdate: StateUpdate): Address {
    return ovmContext.coder.decode(
      Address.default(),
      stateUpdate.stateObject.inputs[0]
    )
  }

  public get address(): string {
    return this.wallet.getAddress().data
  }

  public get syncing(): boolean {
    return this.syncing
  }

  private async getExitDb(
    depositContractAddress: Address
  ): Promise<RangeStore> {
    const exitDb = new RangeDb(
      await this.witnessDb.bucket(Bytes.fromString('exit'))
    )
    const bucket = await exitDb.bucket(
      ovmContext.coder.encode(depositContractAddress)
    )
    return bucket
  }

  private async getClaimDb(): Promise<KeyValueStore> {
    return await this.witnessDb.bucket(Bytes.fromString('claimedProperty'))
  }

  private async getUserActionDb(blockNumber: BigNumber): Promise<RangeStore> {
    const db = await this.witnessDb.bucket(Bytes.fromString('userAction'))
    const bucket = await db.bucket(Bytes.fromString(blockNumber.raw))
    return new RangeDb(bucket)
  }

  /**
   * Get current balance of tokens in plasma.
   * All ERC20 tokens including Peth registered by `registerCustomToken` method or `registerToken` method are included.
   * @returns Array of balance object which has the amount you have and token information.
   *     e.g. For ETH, the unit of amount is "wei" and decimal is 18.
   */
  public async getBalance(): Promise<
    Array<{
      depositContractAddress: string
      amount: JSBI
      decimals: number
    }>
  > {
    const addrs = Array.from(this.depositContracts.keys())
    const resultPromise = addrs.map(async addr => {
      const data = await this.stateManager.getVerifiedStateUpdates(
        Address.from(addr),
        new Range(BigNumber.from(0), BigNumber.MAX_NUMBER) // TODO: get all stateUpdate method
      )
      return {
        depositContractAddress: addr,
        amount: data.reduce((p, s) => JSBI.add(p, s.amount), JSBI.BigInt(0)),
        decimals: this.tokenManager.getDecimal(Address.from(addr))
      }
    })
    return await Promise.all(resultPromise)
  }

  /**
   * start LightClient process.
   */
  public async start() {
    this.commitmentContract.subscribeBlockSubmitted(
      async (blockNumber, root) => {
        console.log('new block submitted event:', root.toHexString())
        this.syncState(blockNumber, root)
        this.verifyPendingStateUpdates(blockNumber)
      }
    )
    this.commitmentContract.startWatchingEvents()
    const blockNumber = await this.commitmentContract.getCurrentBlock()
    await this.syncStateUntill(blockNumber)
    await this.watchAdjudicationContract()
  }

  /**
   * stop LightClient process
   */
  public stop() {
    this.adjudicationContract.unsubscribeAll()
    this.commitmentContract.unsubscribeAll()
    Object.keys(this.depositContracts).forEach(async addr => {
      const depositContract = this.depositContracts.get(addr)
      if (depositContract) {
        depositContract.unsubscribeAll()
      }
    })
  }

  /**
   * sync local state to given block number
   * @param blockNum block number to which client should sync
   */
  private async syncStateUntill(blockNum: BigNumber): Promise<void> {
    let synced = await this.syncManager.getLatestSyncedBlockNumber()
    console.log(`sync state from ${synced} to ${blockNum}`)
    if (JSBI.greaterThan(synced.data, blockNum.data)) {
      throw new Error('Synced state is greater than latest block')
    }

    while (JSBI.notEqual(synced.data, blockNum.data)) {
      synced = BigNumber.from(JSBI.add(synced.data, JSBI.BigInt(1)))
      const root = await this.commitmentContract.getRoot(synced)
      if (!root) {
        // FIXME: check if root is default bytes32 value
        throw new Error('Block root hash is null')
      }
      await this.syncState(synced, root)
    }
  }

  /**
   * fetch latest state from aggregator
   * update local database with new state updates.
   * @param blockNumber block number to sync state
   * @param root root hash of new block to be synced
   */
  private async syncState(blockNumber: BigNumber, root: FixedBytes) {
    this._syncing = true
    console.log(`syncing state: ${blockNumber}`)
    try {
      const res = await this.apiClient.syncState(this.address, blockNumber)
      const stateUpdates: StateUpdate[] = res.data.map((s: string) =>
        StateUpdate.fromProperty(
          decodeStructable(Property, ovmContext.coder, Bytes.fromHexString(s))
        )
      )
      const promises = stateUpdates.map(async su => {
        const inclusionProof = await this.apiClient.inclusionProof(su)
        const hint = createInclusionProofHint(
          blockNumber,
          su.depositContractAddress,
          su.range
        )
        await putWitness(
          this.witnessDb,
          hint,
          Bytes.fromHexString(inclusionProof.data.data)
        )
        await this.stateManager.insertVerifiedStateUpdate(
          su.depositContractAddress,
          su
        )
        // store receive user action
        const { range } = su
        const owner = this.getOwner(su)
        const action = createReceiveUserAction(range, owner, su.blockNumber)
        const db = await this.getUserActionDb(su.blockNumber)
        await db.put(
          range.start.data,
          range.end.data,
          ovmContext.coder.encode(action.toStruct())
        )
      })
      await Promise.all(promises)
      await this.syncManager.updateSyncedBlockNumber(blockNumber, root)
      // TODO: fetch history proofs for unverified state update and verify them.
      this.ee.emit(EmitterEvent.SYNC_FINISHED, blockNumber)
    } catch (e) {
      console.log(e)
    } finally {
      this._syncing = false
    }
  }

  private async verifyPendingStateUpdates(blockNumber: BigNumber) {
    console.group('VERIFY PENDING STATE UPDATES: ', blockNumber.raw)
    Object.keys(this.depositContracts).forEach(async addr => {
      const pendingStateUpdates = await this.stateManager.getPendingStateUpdates(
        Address.from(addr),
        new Range(BigNumber.from(0), BigNumber.MAX_NUMBER)
      )
      const verifier = new DoubleLayerTreeVerifier()
      const root = await this.syncManager.getRoot(blockNumber)
      if (!root) {
        return
      }

      pendingStateUpdates.forEach(async su => {
        console.info(
          `Verify pended state update: (${su.range.start.data.toString()}, ${su.range.end.data.toString()})`
        )
        const res = await this.apiClient.inclusionProof(su)
        if (res.status === 404) {
          return
        }
        const { coder } = ovmContext
        const inclusionProof = decodeStructable(
          DoubleLayerInclusionProof,
          coder,
          Bytes.fromHexString(res.data.data)
        )
        const leaf = new DoubleLayerTreeLeaf(
          su.depositContractAddress,
          su.range.start,
          FixedBytes.from(
            32,
            Keccak256.hash(coder.encode(su.property.toStruct())).data
          )
        )
        if (verifier.verifyInclusion(leaf, su.range, root, inclusionProof)) {
          console.info(
            `Pended state update (${su.range.start.data.toString()}, ${su.range.end.data.toString()}) verified. remove from stateDB`
          )
          await this.stateManager.removePendingStateUpdate(
            su.depositContractAddress,
            su.range
          )

          // store inclusionProof as witness
          const hint = createInclusionProofHint(
            blockNumber,
            su.depositContractAddress,
            su.range
          )
          await putWitness(
            this.witnessDb,
            hint,
            Bytes.fromHexString(res.data.data)
          )

          // store send user action
          const { range } = su
          const owner = this.getOwner(su)
          const action = createSendUserAction(range, owner, su.blockNumber)
          const db = await this.getUserActionDb(su.blockNumber)
          await db.put(
            range.start.data,
            range.end.data,
            ovmContext.coder.encode(action.toStruct())
          )

          this.ee.emit(EmitterEvent.TRANSFER_COMPLETE, su)
        }
      })
    })
    console.groupEnd()
  }

  /**
   * create exit property from StateUpdate
   * If a checkpoint that is same range and block as `stateUpdate` exists, return exitDeposit property.
   * If inclusion proof for `stateUpdate` exists, return exit property.
   * otherwise throw exception
   * @param stateUpdate
   */
  private async createExitProperty(
    stateUpdate: StateUpdate
  ): Promise<Property> {
    const exitPredicate = this.deciderManager.compiledPredicateMap.get('Exit')
    const exitDepositPredicate = this.deciderManager.compiledPredicateMap.get(
      'ExitDeposit'
    )
    if (!exitPredicate) throw new Error('Exit predicate not found')
    if (!exitDepositPredicate)
      throw new Error('ExitDeposit predicate not found')

    const { coder } = ovmContext
    const inputsOfExitProperty = [coder.encode(stateUpdate.property.toStruct())]
    const checkpoints = await this.checkpointManager.getCheckpointsWithRange(
      stateUpdate.depositContractAddress,
      stateUpdate.range
    )
    if (checkpoints.length > 0) {
      const checkpointStateUpdate = StateUpdate.fromProperty(
        checkpoints[0].stateUpdate
      )
      // check stateUpdate is subrange of checkpoint
      if (
        checkpointStateUpdate.depositContractAddress.data ===
          stateUpdate.depositContractAddress.data &&
        JSBI.equal(
          checkpointStateUpdate.blockNumber.data,
          stateUpdate.blockNumber.data
        )
      ) {
        // making exitDeposit property
        inputsOfExitProperty.push(
          coder.encode(checkpoints[0].property.toStruct())
        )
        return exitDepositPredicate.makeProperty(inputsOfExitProperty)
      }
    }
    // making exit property
    const hint = createInclusionProofHint(
      stateUpdate.blockNumber,
      stateUpdate.depositContractAddress,
      stateUpdate.range
    )
    const quantified = await getWitnesses(this.witnessDb, hint)

    if (quantified.length !== 1) {
      throw new Error('invalid range')
    }
    const proof = quantified[0]
    inputsOfExitProperty.push(proof)
    return exitPredicate.makeProperty(inputsOfExitProperty)
  }

  /**
   * Deposit given amount of token to corresponding deposit contract.
   * this method calls `approve` method of ERC20 contract and `deposit` method
   * of Deposit contract.
   * @param amount amount to deposit
   * @param depositContractAddress deposit contract address to deposit into
   */
  public async deposit(
    amount: number | string | JSBI,
    depositContractAddress: string
  ) {
    const addr = Address.from(depositContractAddress)
    const myAddress = this.wallet.getAddress()
    const depositContract = this.getDepositContract(addr)
    const erc20Contract = this.getERC20TokenContract(addr)
    if (!depositContract || !erc20Contract) {
      throw new Error('Contract not found')
    }

    await erc20Contract.approve(
      depositContract.address,
      BigNumber.from(JSBI.BigInt(amount))
    )
    await depositContract.deposit(
      BigNumber.from(JSBI.BigInt(amount)),
      this.ownershipProperty(myAddress)
    )
  }

  /**
   * transfer token to new owner. throw if given invalid inputs.
   * @param amount amount to transfer
   * @param depositContractAddress which token to transfer
   * @param to to whom transfer
   */
  public async transfer(
    amount: number | string | JSBI,
    depositContractAddressString: string,
    toAddress: string
  ) {
    console.log(
      'transfer :',
      amount.toString(),
      depositContractAddressString,
      toAddress
    )
    const to = Address.from(toAddress)
    const ownershipStateObject = this.ownershipProperty(to)
    await this.sendTransaction(
      amount,
      depositContractAddressString,
      ownershipStateObject
    )
  }

  /**
   * send plasma transaction with amount, Deposit Contract address and StateObject.
   * @param amount amount of transaction
   * @param depositContractAddressString which token of transaction
   * @param stateObject property defining deprecate condition of next state
   */
  public async sendTransaction(
    amount: number | string | JSBI,
    depositContractAddressString: string,
    stateObject: Property
  ) {
    const depositContractAddress = Address.from(depositContractAddressString)
    const stateUpdates = await this.stateManager.resolveStateUpdate(
      depositContractAddress,
      amount
    )
    if (stateUpdates === null) {
      throw new Error('Not enough amount')
    }

    const latestBlock = await this.syncManager.getLatestSyncedBlockNumber()
    const transactions = await Promise.all(
      stateUpdates.map(async su => {
        const tx = new Transaction(
          depositContractAddress,
          su.range,
          BigNumber.from(JSBI.add(latestBlock.data, JSBI.BigInt(5))),
          stateObject,
          this.wallet.getAddress()
        )
        const sig = await this.wallet.signMessage(
          ovmContext.coder.encode(tx.toProperty(Address.default()).toStruct())
        )
        tx.signature = sig
        return tx
      })
    )

    const res = await this.apiClient.sendTransaction(transactions)

    if (Array.isArray(res.data)) {
      const receipts = res.data.map(d => {
        return decodeStructable(
          TransactionReceipt,
          ovmContext.coder,
          Bytes.fromHexString(d)
        )
      })

      // TODO: is this valid handling?
      for await (const receipt of receipts) {
        if (receipt.status.data === 1) {
          for await (const su of stateUpdates) {
            await this.stateManager.removeVerifiedStateUpdate(
              su.depositContractAddress,
              su.range
            )
            await this.stateManager.insertPendingStateUpdate(
              su.depositContractAddress,
              su
            )
          }
        } else {
          throw new Error('Invalid transaction')
        }
      }
    }
  }

  /**
   * given ERC20 deposit contract address, returns corresponding deposit contract.
   * @param depositContractAddress deposit contract address
   */
  private getDepositContract(
    depositContractAddress: Address
  ): IDepositContract | undefined {
    return this.depositContracts.get(depositContractAddress.data)
  }

  /**
   * given deposit contract address, returns ERC20 contract instance.
   * @param depositContractAddress corresponding deposit contract address
   */
  private getERC20TokenContract(
    depositContractAddress: Address
  ): IERC20Contract | undefined {
    return this.tokenManager.getTokenContract(depositContractAddress)
  }

  /**
   * register ERC20 custom token.
   * ERC20 contract wrapper is passed directly. This method should be used
   * when you want to use custom IERC20 contract. PETH contract use this method.
   * @param erc20Contract IERC20Contract instance
   * @param depositContract IDepositContract instance
   */
  public async registerCustomToken(
    erc20Contract: IERC20DetailedContract,
    depositContract: IDepositContract
  ) {
    const depositContractAddress = depositContract.address
    this.depositContracts.set(depositContractAddress.data, depositContract)
    await this.tokenManager.addTokenContract(
      depositContractAddress,
      erc20Contract
    )

    depositContract.subscribeDepositedRangeExtended(async (range: Range) => {
      await this.depositedRangeManager.extendRange(
        depositContractAddress,
        range
      )
    })

    depositContract.subscribeDepositedRangeRemoved(async (range: Range) => {
      await this.depositedRangeManager.removeRange(
        depositContractAddress,
        range
      )
    })

    depositContract.subscribeCheckpointFinalized(
      async (checkpointId: Bytes, checkpoint: [Property]) => {
        const checkpointPredicate = this.deciderManager.compiledPredicateMap.get(
          'Checkpoint'
        )
        if (!checkpointPredicate) {
          throw new Error('')
        }
        const c = new Checkpoint(
          checkpointPredicate.deployedAddress,
          checkpoint[0]
        )
        await this.checkpointManager.insertCheckpoint(
          depositContractAddress,
          checkpointId,
          c
        )
        await this.checkpointManager.insertCheckpointWithRange(
          depositContractAddress,
          c
        )

        const stateUpdate = StateUpdate.fromProperty(checkpoint[0])
        const owner = this.getOwner(stateUpdate)
        if (owner && owner.data === this.wallet.getAddress().data) {
          await this.stateManager.insertVerifiedStateUpdate(
            depositContractAddress,
            stateUpdate
          )

          // put deposited action
          const { range, blockNumber } = stateUpdate
          const action = createDepositUserAction(range, blockNumber)
          const db = await this.getUserActionDb(blockNumber)
          await db.put(
            range.start.data,
            range.end.data,
            ovmContext.coder.encode(action.toStruct())
          )
        }
        this.ee.emit(
          EmitterEvent.CHECKPOINT_FINALIZED,
          checkpointId,
          checkpoint
        )
      }
    )
    await depositContract.startWatchingEvents()
  }

  /**
   * register ERC20 token.
   * use default ERC20 contract wrapper
   * @param erc20ContractAddress ERC20 token address to register
   * @param depositContractAddress deposit contract address connecting to tokenAddress above
   */
  public registerToken(
    erc20ContractAddress: string,
    depositContractAddress: string
  ) {
    const depositContract = this.depositContractFactory(
      Address.from(depositContractAddress)
    )
    const erc20Contract = this.tokenContractFactory(
      Address.from(erc20ContractAddress)
    )
    this.registerCustomToken(erc20Contract, depositContract)
  }

  /**
   * Withdrawal process starts from calling this method.
   * Given amount and depositContractAddress, checks if client has sufficient token amount.
   * If client has sufficient amount, create exitProperty from stateUpdates this client owns,
   * calls `claimProperty` method on UniversalAdjudicationContract. Store the property in exitList.
   * User can call `finalizeExit` to withdraw actual token after the exitProperty is decided to true on-chain.
   * @param amount amount to exit
   * @param depositContractAddress deposit contract address to exit
   */
  public async exit(
    amount: number | string | JSBI,
    depositContractAddress: string
  ) {
    const addr = Address.from(depositContractAddress)
    const stateUpdates = await this.stateManager.resolveStateUpdate(
      addr,
      amount
    )
    if (Array.isArray(stateUpdates) && stateUpdates.length > 0) {
      // resolve promises in serial to avoid an error of ethers.js on calling claimProperty
      // "the tx doesn't have the correct nonce."
      for (const stateUpdate of stateUpdates) {
        const exitProperty = await this.createExitProperty(stateUpdate)
        await this.adjudicationContract.claimProperty(exitProperty)
        await this.saveExit(stateUpdate)
      }
    } else {
      throw new Error('Insufficient amount')
    }
  }

  /**
   * Given exit instance, finalize exit to withdraw token from deposit contract.
   * Client checks if the exitProperty of the exit instance is decided by calling `isDecided` method
   * of UniversalAdjudicationContract. If the property claim have not been decided yet, call `decideClaimToTrue`.
   * If the exitProperty had been decided to true, call `finalizeExit` method of corresponding payout contract.
   *
   * @param exit Exit object to finalize
   */
  public async finalizeExit(exit: IExit) {
    const exitProperty = exit.property
    const decided = await this.adjudicationContract.isDecided(exit.id)
    if (!decided) {
      const decidable = await this.adjudicationContract.isDecidable(exit.id)
      if (decidable) {
        await this.adjudicationContract.decideClaimToTrue(exit.id)
        const db = await this.getClaimDb()
        await db.del(exit.id)
      } else {
        throw new Error('Exit property is not decidable')
      }
    }

    const depositedRangeId = await this.depositedRangeManager.getDepositedRangeId(
      exit.stateUpdate.depositContractAddress,
      exit.range
    )

    await this.ownershipPayoutContract.finalizeExit(
      exit.stateUpdate.depositContractAddress,
      exitProperty,
      depositedRangeId,
      Address.from(this.address)
    )

    this.ee.emit(EmitterEvent.EXIT_FINALIZED, exit.id)
  }

  /**
   * Get pending exit list
   */
  public async getExitList(): Promise<IExit[]> {
    const { coder } = ovmContext
    const exitList = await Promise.all(
      Array.from(this.depositContracts.keys()).map(async addr => {
        const exitDb = await this.getExitDb(Address.from(addr))
        const iter = exitDb.iter(JSBI.BigInt(0))
        let item = await iter.next()
        const result: IExit[] = []
        while (item !== null) {
          const p = decodeStructable(Property, coder, item.value)
          if (
            p.deciderAddress.data ===
            this.deciderManager.getDeciderAddress('Exit').data
          ) {
            result.push(Exit.fromProperty(p))
          } else {
            result.push(ExitDeposit.fromProperty(p))
          }
          item = await iter.next()
        }
        return result
      })
    )
    return Array.prototype.concat.apply([], exitList)
  }

  /**
   * @name executeChallenge
   * @description execute challenge procedure to game with challenge property
   * @param gameId Id of the game to challenge
   * @param challenge challenge data structure
   */
  private async executeChallenge(gameId: Bytes, challenge: Challenge) {
    await executeChallenge(
      this.adjudicationContract,
      this.deciderManager,
      gameId,
      challenge
    )
  }

  private async watchAdjudicationContract() {
    this.adjudicationContract.subscribeClaimChallenged(
      async (gameId, challengeGameId) => {
        const db = await this.getClaimDb()
        const property = db.get(gameId)
        if (property) {
          // challenged property is the one this client claimed
          const game = await this.adjudicationContract.getGame(challengeGameId)
          const decision = await this.deciderManager.decide(game.property)
          if (!decision.outcome) {
            // challenge again
            const challenge = decision.challenges[0]
            await this.executeChallenge(gameId, challenge)
          }
        }
      }
    )

    this.adjudicationContract.subscribeNewPropertyClaimed(
      async (gameId, property, createdBlock) => {
        console.log(
          'property is claimed',
          gameId.toHexString(),
          property.deciderAddress.data,
          createdBlock
        )
        if (
          property.deciderAddress.data ===
          this.deciderManager.getDeciderAddress('Exit').data
        ) {
          console.log('Exit property claimed')
          const exit = Exit.fromProperty(property)
          const { range, depositContractAddress } = exit.stateUpdate

          // TODO: implement general way to check if client should challenge claimed property.
          const stateUpdates = await this.stateManager.getVerifiedStateUpdates(
            depositContractAddress,
            range
          )
          if (stateUpdates.length > 0) {
            const decision = await this.deciderManager.decide(property)
            if (this.getOwner(exit.stateUpdate).data === this.address) {
              // exit initiated with this client. save exit into db
              await this.saveExit(exit.stateUpdate)
            } else if (!decision.outcome && decision.challenges.length > 0) {
              // exit is others. need to challenge
              const challenge = decision.challenges[0]
              await this.executeChallenge(gameId, challenge)
            }
          }
        }
      }
    )

    this.adjudicationContract.subscribeClaimDecided(
      async (gameId, decision) => {
        const db = await this.getClaimDb()
        await db.del(gameId)
      }
    )

    await this.adjudicationContract.startWatchingEvents()
  }

  private async saveExit(stateUpdate: StateUpdate) {
    const { coder } = ovmContext
    const exitProperty = await this.createExitProperty(stateUpdate)
    const propertyBytes = coder.encode(exitProperty.toStruct())
    const exitDb = await this.getExitDb(stateUpdate.depositContractAddress)
    await exitDb.put(
      stateUpdate.range.start.data,
      stateUpdate.range.end.data,
      propertyBytes
    )
    await this.stateManager.removeVerifiedStateUpdate(
      stateUpdate.depositContractAddress,
      stateUpdate.range
    )
    await this.stateManager.insertExitStateUpdate(
      stateUpdate.depositContractAddress,
      stateUpdate
    )
    const id = Keccak256.hash(propertyBytes)
    const claimDb = await this.getClaimDb()
    await claimDb.put(id, propertyBytes)

    // put exit action
    const { range } = stateUpdate
    const blockNumber = await this.commitmentContract.getCurrentBlock()
    const action = createExitUserAction(range, blockNumber)
    const db = await this.getUserActionDb(blockNumber)
    await db.put(
      range.start.data,
      range.end.data,
      ovmContext.coder.encode(action.toStruct())
    )
  }

  /**
   * get all user actions until currentBlockNumber
   */
  public async getAllUserActions(): Promise<UserAction[]> {
    let result: UserAction[] = []
    const currentBlockNumber = await this.commitmentContract.getCurrentBlock()
    let blockNumber = JSBI.BigInt(0)
    while (JSBI.lessThanOrEqual(blockNumber, currentBlockNumber.data)) {
      const actions = await this.getUserActions(BigNumber.from(blockNumber))
      result = result.concat(actions)
      blockNumber = JSBI.add(blockNumber, JSBI.BigInt(1))
    }
    return result
  }

  /**
   * get user actions at given blockNumber
   * @param blockNumber blockNumber to get userAction
   */
  public async getUserActions(blockNumber: BigNumber): Promise<UserAction[]> {
    const bucket = await this.getUserActionDb(blockNumber)
    const iter = bucket.iter(JSBI.BigInt(0))
    let item = await iter.next()
    const result: UserAction[] = []
    while (item !== null) {
      result.push(
        UserAction.fromStruct(
          ovmContext.coder.decode(UserAction.getParamTypes(), item.value)
        )
      )
      item = await iter.next()
    }
    return result
  }

  //
  // Events subscriptions
  //

  public subscribeCheckpointFinalized(
    handler: (checkpointId: Bytes, checkpoint: [Range, Property]) => void
  ) {
    this.ee.on(EmitterEvent.CHECKPOINT_FINALIZED, handler)
  }

  public subscribeSyncFinished(handler: (blockNumber: BigNumber) => void) {
    this.ee.on(EmitterEvent.SYNC_FINISHED, handler)
  }

  public subscribeTransferComplete(handler: (su: StateUpdate) => void) {
    this.ee.on(EmitterEvent.TRANSFER_COMPLETE, handler)
  }

  public subscribeExitFinalized(handler: (exitId: Bytes) => void) {
    this.ee.on(EmitterEvent.EXIT_FINALIZED, handler)
  }

  public unsubscribeCheckpointFinalized(
    handler: (checkpointId: Bytes, checkpoint: [Range, Property]) => void
  ) {
    this.ee.off(EmitterEvent.CHECKPOINT_FINALIZED, handler)
  }

  public unsubscribeSyncFinished(handler: (blockNumber: BigNumber) => void) {
    this.ee.off(EmitterEvent.SYNC_FINISHED, handler)
  }

  public unsubscribeTransferComplete(handler: (su: StateUpdate) => void) {
    this.ee.off(EmitterEvent.TRANSFER_COMPLETE, handler)
  }

  public unsubscribeExitFinalized(handler: (exitId: Bytes) => void) {
    this.ee.off(EmitterEvent.EXIT_FINALIZED, handler)
  }
}
