import { MARKET_STAGES, TX_LOOKUP_TIME } from '../utils/constants'
import { logInfo, logSuccess } from '../utils/log'
import { isPlayMoneyToken, getPlayMoneyTokenInstance } from '../utils/tokens'
import CentralizedOracle from './../oracles/centralizedOracle'
import CategoricalEvent from './../events/categoricalEvent'
import ScalarEvent from './../events/scalarEvent'
import { promisify } from '@gnosis.pm/pm-js'
import sleep from 'sleep'

class Market {
  constructor (marketInfo, configInstance) {
    this._marketInfo = Object.assign({}, marketInfo)
    Object.assign(
      this._marketInfo,
      {
        event: configInstance.gnosisJS.contracts.Event.at(marketInfo.eventAddress),
        marketMaker: configInstance.gnosisJS.lmsrMarketMaker,
        gasPrice: configInstance.gasPrice
      }
    )
    this._configInstance = configInstance
    this._marketAddress = marketInfo.marketAddress || null
  }

  async create () {
    try {
      const market = await this._configInstance.gnosisJS.createMarket(this._marketInfo)
      this._marketAddress = market.address
    } catch (error) {
      console.log(error)
      throw error
    }
  }

  async fund () {
    let txReceipt
    const market = this._configInstance.gnosisJS.contracts.Market.at(this._marketAddress)
    const collateralTokenInstance = this._configInstance.gnosisJS.contracts.Token.at(this._configInstance.collateralToken)

    // Check if token is play money token
    if (await isPlayMoneyToken(this._configInstance)) {
      const playTokenInstance = getPlayMoneyTokenInstance(this._configInstance)
      await playTokenInstance.allowTransfers([
        this._marketInfo.marketAddress,
        this._marketInfo.eventAddress
      ])
    }

    // Approve tokens transferral
    await collateralTokenInstance.approve(this._marketAddress, this._marketInfo.funding)

    // // Fund market
    const txResponse = await market.fund(this._marketInfo.funding)

    // First transaction check
    if (txResponse.receipt && parseInt(txResponse.receipt.status) === 0) {
      throw new Error(`Funding transaction for market ${this._marketAddress} failed.`)
    } else if (txResponse.receipt && parseInt(txResponse.receipt.status) === 1) {
      // success
      return
    }

    logInfo(`Waiting for funding transaction to be mined, tx hash: ${txResponse.tx}`)

    const web3 = this._configInstance.blockchainProvider.getWeb3()
    while (true) {
      sleep.msleep(TX_LOOKUP_TIME)
      txReceipt = await promisify(web3.eth.getTransactionReceipt)(txResponse.tx)
      // the transaction receipt shall cointain the status property
      // which is [0, 1] for local ganache nodes, ['0x0' , '0x1'] on testnets
      if (!txReceipt) {
        continue
      } else if (txReceipt && txReceipt.status === 0) {
        // handle error, transaction failed
        throw new Error(`Funding transaction for market ${this._marketAddress} failed.`)
      } else if (txReceipt && txReceipt.status === 1) {
        break
      } else if (txReceipt && txReceipt.status === '0x0') {
        throw new Error(`Funding transaction for market ${this._marketAddress} failed.`)
      } else if (txReceipt && txReceipt.status === '0x1') {
        break
      }
    }
    logInfo('Funding transaction was mined')
  }

  async resolve () {
    let oracle, outcomeSet, event, txReceipt
    let market = await this._configInstance.gnosisJS.contracts.Market.at(this._marketAddress)
    let stage = await market.stage()
    if (stage.toNumber() === MARKET_STAGES.created) {
      throw new Error(`Market ${this._marketAddress} cannot be resolved. It must be in funded stage (current stage is CREATED)`)
    } else if (stage.toNumber() === MARKET_STAGES.closed) {
      throw new Error(`Market ${this._marketAddress} cannot be resolved. It must be in funded stage (current stage is CLOSED)`)
    } else {
      // Resolve market
      // await this._configInstance.gnosisJS.resolveEvent({event: this._marketInfo.event, outcome: this._marketInfo.winningOutcome})
      const web3 = this._configInstance.blockchainProvider.getWeb3()
      // Resolve oracle
      oracle = new CentralizedOracle(this._marketInfo, this._configInstance)
      if (!(await oracle.isResolved())) {
        logInfo('Setting outcome on the Oracle')
        const oracleTxResponse = await oracle.resolve(this._marketInfo.winningOutcome)
        logInfo(`Waiting for oracle setOutcome transaction to be mined, tx hash: ${oracleTxResponse.tx}`)

        while (true) {
          sleep.msleep(TX_LOOKUP_TIME)
          txReceipt = await promisify(web3.eth.getTransactionReceipt)(oracleTxResponse.tx)
          // the transaction receipt shall cointain the status property
          // which is [0, 1] for local ganache nodes, ['0x0' , '0x1'] on testnets
          if (!txReceipt) {
            continue
          } else if (txReceipt && txReceipt.status === 0) {
            // handle error, transaction failed
            throw new Error('Set outcome transaction has failed.')
          } else if (txReceipt && txReceipt.status === 1) {
            logInfo('Oracle setOutcome transaction was mined')
            break
          } else if (txReceipt && txReceipt.status === '0x0') {
            throw new Error('Set outcome transaction has failed.')
          } else if (txReceipt && txReceipt.status === '0x1') {
            logInfo('Oracle setOutcome transaction was mined')
            break
          }
        }
      } else {
        logInfo('Oracle already resolved')
      }
      // Resolve event
      if (this._marketInfo.outcomeType === 'SCALAR') {
        event = new ScalarEvent(this._marketInfo, this._configInstance)
      } else {
        event = new CategoricalEvent(this._marketInfo, this._configInstance)
      }

      if (!(await event.isResolved())) {
        logInfo('Setting outcome on the Event')
        const eventTxResponse = await event.resolve()
        logInfo(`Waiting for event setOutcome transaction to be mined, tx hash: ${eventTxResponse.tx}`)

        while (true) {
          sleep.msleep(TX_LOOKUP_TIME)
          txReceipt = await promisify(web3.eth.getTransactionReceipt)(eventTxResponse.tx)
          // the transaction receipt shall cointain the status property
          // which is [0, 1] for local ganache nodes, ['0x0' , '0x1'] on testnets
          if (!txReceipt) {
            continue
          } else if (txReceipt && txReceipt.status === 0) {
            // handle error, transaction failed
            throw new Error('Set outcome transaction has failed.')
          } else if (txReceipt && txReceipt.status === 1) {
            logInfo('Event setOutcome transaction was mined')
            break
          } else if (txReceipt && txReceipt.status === '0x0') {
            throw new Error('Set outcome transaction has failed.')
          } else if (txReceipt && txReceipt.status === '0x1') {
            logInfo('Event setOutcome transaction was mined')
            break
          }
        }
      } else {
        logInfo('Event already resolved')
      }

      await market.close() // this._configInstance.gnosisJS.contracts.Market.close()
      // Wait for the transaction to take effect
      logInfo(`Waiting for market resolution process to complete...`)
      while (true) {
        oracle = await this._configInstance.gnosisJS.contracts.CentralizedOracle.at(this._marketInfo.oracleAddress)
        market = await this._configInstance.gnosisJS.contracts.Market.at(this._marketAddress)
        stage = await market.stage()
        outcomeSet = await oracle.isOutcomeSet()
        if (stage.toNumber() === MARKET_STAGES.closed && outcomeSet) {
          break
        }
        sleep.msleep(TX_LOOKUP_TIME)
      }
      logSuccess(`Market ${this._marketAddress} resolved successfully`)
    }

    this._winningOutcome = this._marketInfo.winningOutcome
  }

  setAddress (address) {
    this._marketAddress = address
  }

  getAddress () {
    return this._marketAddress
  }

  getData () {
    return this._marketInfo
  }

  getWinningOutcome () {
    return this._winningOutcome
  }

  async getStage () {
    return this._configInstance.gnosisJS.contracts.Market.at(this._marketAddress).stage()
  }

  async isResolved () {
    const oracle = await this._configInstance.gnosisJS.contracts.CentralizedOracle.at(this._marketInfo.oracleAddress)
    return oracle.isSet()
  }
}

module.exports = Market
