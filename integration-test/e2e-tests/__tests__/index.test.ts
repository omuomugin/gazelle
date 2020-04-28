import * as ethers from 'ethers'
import { Bytes } from '@cryptoeconomicslab/primitives'
import { LevelKeyValueStore } from '@cryptoeconomicslab/level-kvs'
import initializeLightClient from '@cryptoeconomicslab/eth-plasma-light-client'
import LightClient from '@cryptoeconomicslab/plasma-light-client'
import JSBI from 'jsbi'
import parseEther = ethers.utils.parseEther
import parseUnits = ethers.utils.parseUnits
import formatUnits = ethers.utils.formatUnits
import { ActionType } from '@cryptoeconomicslab/plasma-light-client/lib/UserAction'

import config from '../config.local.json'

jest.setTimeout(120000)

function sleep(ms: number) {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

function parseUnitsToJsbi(amount: string) {
  return JSBI.BigInt(parseUnits(amount, 18).toString())
}

function formatUnitsFromJsbi(amount: JSBI) {
  return formatUnits(amount.toString(), 18)
}

describe('light client', () => {
  const nodeEndpoint = 'http://ganache:8545'
  const aggregatorEndpoint = 'http://aggregator:3000'
  let aliceLightClient: LightClient
  let bobLightClient: LightClient
  let senderWallet: ethers.Wallet
  let recieverWallet: ethers.Wallet

  async function increaseBlock() {
    for (let i = 0; i < 10; i++) {
      await senderWallet.sendTransaction({
        to: senderWallet.address,
        value: parseEther('0.00001')
      })
    }
  }

  async function checkBalance(lightClient: LightClient, amount: string) {
    const balance = await lightClient.getBalance()
    expect(JSBI.equal(balance[0].amount, parseUnitsToJsbi(amount))).toBeTruthy()
  }

  async function getBalance(lightClient: LightClient) {
    const balance = await lightClient.getBalance()
    return formatUnitsFromJsbi(balance[0].amount)
  }

  async function getL1PETHBalance(lightClient: LightClient) {
    const abi = ['function balanceOf(address) view returns (uint256)']
    const connection = new ethers.Contract(
      config.PlasmaETH,
      abi,
      lightClient['wallet']['ethersWallet']
    )
    const balance = await connection.balanceOf(lightClient.address)
    return formatUnits(balance, 18)
  }

  async function finalizeExit(lightClient: LightClient) {
    const exitList = await lightClient.getExitList()
    for (let i = 0; i < exitList.length; i++) {
      await lightClient.finalizeExit(exitList[i])
      // Consecutive finalizeExit call must fail because of invalid Deposited range ID
      await sleep(10000)
    }
  }

  beforeEach(async () => {
    const provider = new ethers.providers.JsonRpcProvider(nodeEndpoint)
    senderWallet = ethers.Wallet.createRandom().connect(provider)
    recieverWallet = ethers.Wallet.createRandom().connect(provider)
    const defaultWallet1 = new ethers.Wallet(
      '0xc87509a1c067bbde78beb793e6fa76530b6382a4c0241e5e4a9ec0a0f44dc0d3',
      provider
    )
    const defaultWallet2 = new ethers.Wallet(
      '0xae6ae8e5ccbfb04590405997ee2d52d2b330726137b875053c36d94e974d162f',
      provider
    )
    const kvs1 = new LevelKeyValueStore(
      Bytes.fromString('plasma_light_client_' + defaultWallet1.address)
    )
    const kvs2 = new LevelKeyValueStore(
      Bytes.fromString('plasma_light_client_' + defaultWallet2.address)
    )

    await defaultWallet1.sendTransaction({
      to: senderWallet.address,
      value: parseEther('1.0')
    })
    await defaultWallet2.sendTransaction({
      to: recieverWallet.address,
      value: parseEther('1.0')
    })

    aliceLightClient = await initializeLightClient({
      wallet: senderWallet,
      kvs: kvs1,
      config: config as any,
      aggregatorEndpoint
    })
    bobLightClient = await initializeLightClient({
      wallet: recieverWallet,
      kvs: kvs2,
      config: config as any,
      aggregatorEndpoint
    })
    await aliceLightClient.start()
    await bobLightClient.start()
  })

  afterEach(async () => {
    aliceLightClient.stop()
    bobLightClient.stop()
  })

  /**
   * basic scenario
   * Alice deposit 0.1 ETH
   * Alice transfer 0.1 ETH to Bob
   * Bob attemts exit 0.1 ETH
   */
  test('user deposits, transfers and attempts exit asset', async () => {
    await aliceLightClient.deposit(
      parseUnitsToJsbi('0.1'),
      config.payoutContracts.DepositContract
    )
    await sleep(10000)

    expect(await getBalance(aliceLightClient)).toEqual('0.1')

    await aliceLightClient.transfer(
      parseUnitsToJsbi('0.1'),
      config.payoutContracts.DepositContract,
      bobLightClient.address
    )
    await sleep(20000)

    expect(await getBalance(aliceLightClient)).toEqual('0.0')
    expect(await getBalance(bobLightClient)).toEqual('0.1')

    await bobLightClient.exit(
      parseUnitsToJsbi('0.05'),
      config.payoutContracts.DepositContract
    )
    await sleep(10000)

    expect(await getBalance(bobLightClient)).toEqual('0.05')

    const exitList = await bobLightClient.getExitList()
    expect(exitList.length).toBe(1)

    await increaseBlock()

    expect(await getL1PETHBalance(bobLightClient)).toEqual('0.0')
    await finalizeExit(bobLightClient)
    expect(await getL1PETHBalance(bobLightClient)).toEqual('0.05')

    const aliceActions = await aliceLightClient.getAllUserActions()
    const bobActions = await bobLightClient.getAllUserActions()

    // TODO: Send action isn't stored
    // expect(aliceActions[0].type).toEqual(ActionType.Send)
    // expect(aliceActions[0].amount).toEqual(parseUnitsToJsbi('0.1'))
    expect(aliceActions[0].type).toEqual(ActionType.Deposit)
    expect(aliceActions[0].amount).toEqual(parseUnitsToJsbi('0.1'))
    expect(bobActions[0].type).toEqual(ActionType.Exit)
    expect(bobActions[0].amount).toEqual(parseUnitsToJsbi('0.05'))
    expect(bobActions[1].type).toEqual(ActionType.Receive)
    expect(bobActions[1].amount).toEqual(parseUnitsToJsbi('0.1'))
  })

  /**
   * exit deposit scenario
   * Alice deposits 0.1 ETH
   * Alice exit 0.05 ETH
   */
  test('user attempts exit depositted asset', async () => {
    await aliceLightClient.deposit(
      parseUnitsToJsbi('0.1'),
      config.payoutContracts.DepositContract
    )
    await sleep(10000)

    expect(await getBalance(aliceLightClient)).toEqual('0.1')

    await aliceLightClient.exit(
      parseUnitsToJsbi('0.05'),
      config.payoutContracts.DepositContract
    )
    await sleep(10000)

    expect(await getBalance(aliceLightClient)).toEqual('0.05')

    const exitList = await aliceLightClient.getExitList()
    expect(exitList.length).toBe(1)

    await increaseBlock()

    expect(await getL1PETHBalance(aliceLightClient)).toEqual('0.0')
    await finalizeExit(aliceLightClient)
    expect(await getL1PETHBalance(aliceLightClient)).toEqual('0.05')
  })

  /**
   * multiple transfers scenario
   * Alice and Bob deposit 0.5 ETH
   * Alice sends 0.2 ETH to Bob by 2 transactions
   * Bob sends 0.1 ETH to Alice by 1 transaction
   * exit all asset
   */
  test('multiple transfers in same block', async () => {
    console.log('multiple transfers in same block')
    await aliceLightClient.deposit(
      parseUnitsToJsbi('0.5'),
      config.payoutContracts.DepositContract
    )
    await bobLightClient.deposit(
      parseUnitsToJsbi('0.5'),
      config.payoutContracts.DepositContract
    )

    await sleep(10000)

    await checkBalance(aliceLightClient, '0.5')
    await checkBalance(bobLightClient, '0.5')

    await aliceLightClient.transfer(
      parseUnitsToJsbi('0.1'),
      config.payoutContracts.DepositContract,
      bobLightClient.address
    )
    await bobLightClient.transfer(
      parseUnitsToJsbi('0.1'),
      config.payoutContracts.DepositContract,
      aliceLightClient.address
    )
    await aliceLightClient.transfer(
      parseUnitsToJsbi('0.1'),
      config.payoutContracts.DepositContract,
      bobLightClient.address
    )

    await sleep(20000)

    await checkBalance(aliceLightClient, '0.4')
    await checkBalance(bobLightClient, '0.6')

    await aliceLightClient.exit(
      parseUnitsToJsbi('0.4'),
      config.payoutContracts.DepositContract
    )
    await bobLightClient.exit(
      parseUnitsToJsbi('0.6'),
      config.payoutContracts.DepositContract
    )
    await sleep(10000)

    await checkBalance(aliceLightClient, '0.0')
    await checkBalance(bobLightClient, '0.0')

    await increaseBlock()

    expect(await getL1PETHBalance(aliceLightClient)).toEqual('0.0')
    expect(await getL1PETHBalance(bobLightClient)).toEqual('0.0')
    await finalizeExit(aliceLightClient)
    await finalizeExit(bobLightClient)
    expect(await getL1PETHBalance(aliceLightClient)).toEqual('0.4')
    expect(await getL1PETHBalance(bobLightClient)).toEqual('0.6')
  })

  /**
   * deposit after withdraw scenario
   * Alice deposits 0.5 ETH
   * Alice sends 0.5 ETH to Bob
   * Bob attemts exit 0.3 ETH
   * Bob withdraw 0.2 ETH
   * Alice deposit 0.1 ETH
   * Bob deposit 0.8 ETH
   */
  test('deposit after withdraw', async () => {
    console.log('deposit after withdraw')
    await aliceLightClient.deposit(
      parseUnitsToJsbi('0.5'),
      config.payoutContracts.DepositContract
    )
    await sleep(10000)

    expect(await getBalance(aliceLightClient)).toEqual('0.5')

    await aliceLightClient.transfer(
      parseUnitsToJsbi('0.5'),
      config.payoutContracts.DepositContract,
      bobLightClient.address
    )
    await sleep(20000)

    expect(await getBalance(aliceLightClient)).toEqual('0.0')
    expect(await getBalance(bobLightClient)).toEqual('0.5')

    await bobLightClient.exit(
      parseUnitsToJsbi('0.2'),
      config.payoutContracts.DepositContract
    )
    await sleep(10000)

    expect(await getBalance(bobLightClient)).toEqual('0.3')

    await increaseBlock()

    expect(await getL1PETHBalance(bobLightClient)).toEqual('0.0')
    await finalizeExit(bobLightClient)
    expect(await getL1PETHBalance(bobLightClient)).toEqual('0.2')

    await aliceLightClient.deposit(
      parseUnitsToJsbi('0.1'),
      config.payoutContracts.DepositContract
    )
    await bobLightClient.deposit(
      parseUnitsToJsbi('0.8'),
      config.payoutContracts.DepositContract
    )
    await sleep(10000)

    expect(await getBalance(aliceLightClient)).toEqual('0.1')
    expect(await getBalance(bobLightClient)).toEqual('1.1')
  })

  /**
   * transfer after error
   * Alice deposit 0.2 ETH
   * Alice tries to send 0.5 ETH to Bob, but gets error
   * Alice tries to exit 0.5 ETH, but gets error
   * Alice sends 0.1 ETH to Bob
   */
  test('transfer after error', async () => {
    await aliceLightClient.deposit(
      parseUnitsToJsbi('0.2'),
      config.payoutContracts.DepositContract
    )
    await sleep(10000)

    await checkBalance(aliceLightClient, '0.2')
    await checkBalance(bobLightClient, '0.0')

    await expect(
      aliceLightClient.transfer(
        parseUnitsToJsbi('0.5'),
        config.payoutContracts.DepositContract,
        bobLightClient.address
      )
    ).rejects.toEqual(new Error('Not enough amount'))

    await expect(
      aliceLightClient.exit(
        parseUnitsToJsbi('0.5'),
        config.payoutContracts.DepositContract
      )
    ).rejects.toEqual(new Error('Insufficient amount'))

    await checkBalance(aliceLightClient, '0.2')
    await checkBalance(bobLightClient, '0.0')

    aliceLightClient.transfer(
      parseUnitsToJsbi('0.1'),
      config.payoutContracts.DepositContract,
      bobLightClient.address
    )
    await sleep(20000)

    await checkBalance(aliceLightClient, '0.1')
    await checkBalance(bobLightClient, '0.1')

    const aliceActions = await aliceLightClient.getAllUserActions()
    const bobActions = await bobLightClient.getAllUserActions()

    // TODO: Send action isn't stored
    expect(aliceActions[0].type).toEqual(ActionType.Deposit)
    expect(aliceActions[0].amount).toEqual(parseUnitsToJsbi('0.2'))
    expect(bobActions[0].type).toEqual(ActionType.Receive)
    expect(bobActions[0].amount).toEqual(parseUnitsToJsbi('0.1'))
  })
})
