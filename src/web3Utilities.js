const ethUtil = require('ethereumjs-util')
const ethSigUtil = require('eth-sig-util')
const listeners = require('./web3Listeners')

const ERC20ABI = [{"constant":true,"inputs":[{"name":"_owner","type":"address"}],"name":"balanceOf","outputs":[{"name":"balance","type":"uint256"}],"payable":false,"stateMutability":"view","type":"function"},{"constant":true,"inputs":[],"name":"decimals","outputs":[{"name":"","type":"uint8"}],"payable":false,"stateMutability":"view","type":"function"}] // eslint-disable-line

const networkDataById = {
  1: {
    name: 'Mainnet',
    type: 'PoW',
    etherscanPrefix: ''
  },
  3: {
    name: 'Ropsten',
    type: 'PoW',
    etherscanPrefix: 'ropsten.'
  },
  4: {
    name: 'Rinkeby',
    type: 'PoA',
    etherscanPrefix: 'rinkeby.'
  },
  42: {
    name: 'Kovan',
    type: 'PoA',
    etherscanPrefix: 'kovan.'
  }
}

const getEthereumVariables = {
  web3js: () => { return listeners.getWeb3js() },
  account: () => { return listeners.getAccount() },
  networkId: () => { return listeners.getNetworkId() }
}

const _setEthereumVariableGetters = (getters) => {
  Object.keys(getters).forEach(getter => {
    getEthereumVariables[getter] = getters[getter]
  })
}

const sendTransaction = (method, handlers) => {
  let requiredHandlers = ['error']
  let optionalHandlers = ['transactionHash', 'receipt', 'confirmation']
  let allHandlers = requiredHandlers.concat(optionalHandlers)
  // ensure an error handler was passed
  if (!requiredHandlers.every(handler => { return Object.keys(handlers).includes(handler) })) {
    throw Error('Please provide an \'error\' handler.')
  }
  // ensure only allowed handlers can be passed
  if (!Object.keys(handlers).every(handler => { return allHandlers.includes(handler) })) {
    throw Error(`Invalid handler passed. Allowed handlers are: '${allHandlers.toString().join(`', '`)}'.`)
  }
  // for all handlers that weren't passed, set them as empty functions
  for (let i = 0; i < allHandlers.length; i++) {
    if (handlers[allHandlers[i]] === undefined) handlers[allHandlers[i]] = () => {}
  }

  // define promises for the variables we need to validate/send the transaction
  var gasPricePromise = () => {
    return getEthereumVariables.web3js().eth.getGasPrice()
      .catch(error => {
        handlers['error'](error, 'Could not fetch gas price.')
        return null
      })
  }

  var gasPromise = () => {
    return method.estimateGas({ from: getEthereumVariables.account() })
      .catch(error => {
        handlers['error'](error, 'The transaction would fail.')
        return null
      })
  }

  let balanceWeiPromise = () => {
    return getBalance(undefined, 'wei')
      .catch(error => {
        handlers['error'](error, 'Could not fetch sending address balance.')
        return null
      })
  }

  let handledErrorName = 'HandledError'

  return Promise.all([gasPricePromise(), gasPromise(), balanceWeiPromise()])
    .then(results => {
      // ensure that none of the promises failed
      if (results.some(result => { return result === null })) {
        let error = Error('This error was already handled.')
        error.name = handledErrorName
        throw error
      }

      // extract variables
      let [gasPrice, gas, balanceWei] = results

      // ensure the sender has enough ether to pay gas
      let safeGas = parseInt(gas * 1.1)
      let requiredWei = new ethUtil.BN(gasPrice).mul(new ethUtil.BN(safeGas))
      if (new ethUtil.BN(balanceWei).lt(requiredWei)) {
        let requiredEth = toDecimal(requiredWei.toString(), '18')
        let errorMessage = `Insufficient balance. Ensure you have at least ${requiredEth} ETH.`
        handlers['error'](Error(errorMessage), errorMessage)
        return
      }

      // send the transaction
      method.send({ from: getEthereumVariables.account(), gasPrice: gasPrice, gas: safeGas })
        .on('transactionHash', transactionHash => {
          handlers['transactionHash'](transactionHash)
        })
        .on('receipt', (receipt) => {
          handlers['receipt'](receipt)
        })
        .on('confirmation', (confirmationNumber, receipt) => {
          handlers['confirmation'](confirmationNumber, receipt)
        })
        .on('error', error => {
          handlers['error'](error, 'Unable to send transaction.')
        })
    })
    .catch(error => {
      if (error.name !== handledErrorName) { handlers['error'](error, 'Unexpected error.') }
    })
}

const signPersonal = (message) => {
  var from = getEthereumVariables.account()
  if (!ethUtil.isValidChecksumAddress(from)) throw Error(`Current account '${from}' has an invalid checksum.`)

  let encodedMessage = ethUtil.bufferToHex(Buffer.from(message, 'utf8'))

  return new Promise((resolve, reject) => {
    getEthereumVariables.web3js().currentProvider.sendAsync({
      method: 'personal_sign',
      params: [encodedMessage, from],
      from: from
    }, (error, result) => {
      if (error) return reject(error)
      if (result.error) return reject(result.error.message)

      let returnData = {}
      returnData.signature = result.result

      var signature = ethUtil.fromRpcSig(returnData.signature)
      returnData.r = ethUtil.addHexPrefix(Buffer.from(signature.r).toString('hex'))
      returnData.s = ethUtil.addHexPrefix(Buffer.from(signature.s).toString('hex'))
      returnData.v = signature.v

      // ensure that the signature matches
      var recovered = ethUtil.ecrecover(
        ethUtil.hashPersonalMessage(ethUtil.toBuffer(message)),
        signature.v, ethUtil.toBuffer(signature.r), ethUtil.toBuffer(signature.s)
      )
      if (ethUtil.toChecksumAddress(ethUtil.pubToAddress(recovered).toString('hex')) !== from) {
        return reject(Error(`The returned signature '${returnData.signature}' didn't originate from address '${from}'.`))
      }
      returnData.from = from

      resolve(returnData)
    })
  })
}

const signTypedData = (typedData) => {
  var from = getEthereumVariables.account()
  if (!ethUtil.isValidChecksumAddress(from)) throw Error(`Current account '${from}' has an invalid checksum.`)

  // we have to do it this way because web3 1.0 doesn't expose this functionality
  return new Promise((resolve, reject) => {
    getEthereumVariables.web3js().currentProvider.sendAsync({
      method: 'eth_signTypedData',
      params: [typedData, from],
      from: from
    }, (error, result) => {
      if (error) return reject(error)
      if (result.error) return reject(result.error.message)

      let returnData = {}
      returnData.signature = result.result

      // ensure that the signature matches
      var recovered = ethSigUtil.recoverTypedSignature({
        data: typedData,
        sig: returnData.signature
      })
      if (ethUtil.toChecksumAddress(recovered) !== from) {
        return reject(Error(`Returned signature '${returnData.signature}' didn't originate from address '${from}'.`))
      }
      returnData.from = from

      returnData.messageHash = ethSigUtil.typedSignatureHash(typedData)

      var signature = ethUtil.fromRpcSig(returnData.signature)
      returnData.r = ethUtil.addHexPrefix(Buffer.from(signature.r).toString('hex'))
      returnData.s = ethUtil.addHexPrefix(Buffer.from(signature.s).toString('hex'))
      returnData.v = signature.v

      resolve(returnData)
    })
  })
}

const getBalance = (account, format) => {
  if (account === undefined) account = getEthereumVariables.account()
  if (format === undefined) format = 'ether'

  return getEthereumVariables.web3js().eth.getBalance(account)
    .then(balance => {
      return getEthereumVariables.web3js().utils.fromWei(balance, format)
    })
}

const getERC20Balance = (ERC20Address, account) => {
  if (account === undefined) account = getEthereumVariables.account()

  let ERC20 = getContract(ERC20ABI, ERC20Address)

  let decimalsPromise = () => { return ERC20.methods.decimals().call() }
  let balancePromise = () => { return ERC20.methods.balanceOf(account).call() }

  return Promise.all([balancePromise(), decimalsPromise()])
    .then(([balance, decimals]) => {
      return toDecimal(balance, decimals)
    })
}

const toDecimal = (number, decimals) => {
  if (number.length < decimals) {
    number = '0'.repeat(decimals - number.length) + number
  }
  let difference = number.length - decimals

  let integer = difference === 0 ? '0' : number.slice(0, difference)
  let fraction = number.slice(difference).replace(/0+$/g, '')

  return integer + (fraction === '' ? '' : '.') + fraction
}

const fromDecimal = (number, decimals) => {
  var [integer, fraction] = number.split('.')
  fraction = fraction === undefined ? '' : fraction
  if (fraction.length > decimals) throw new Error('The fractional amount of the passed number was too high')
  fraction = fraction + '0'.repeat(decimals - fraction.length)
  return integer + fraction
}

const getNetworkName = (networkId) => {
  networkId = networkId === undefined ? String(getEthereumVariables.networkId()) : String(networkId)
  if (!Object.keys(networkDataById).includes(networkId)) throw Error(`Network id '${networkId}' is invalid.`)
  return networkDataById[networkId].name
}

const getNetworkType = (networkId) => {
  networkId = networkId === undefined ? String(getEthereumVariables.networkId()) : String(networkId)
  if (!Object.keys(networkDataById).includes(networkId)) throw Error(`Network id '${networkId}' is invalid.`)
  return networkDataById[networkId].type
}

const getContract = (ABI, address, options) => {
  let web3js = getEthereumVariables.web3js()
  return new web3js.eth.Contract(ABI, address, options)
}

const etherscanFormat = (type, data, networkId) => {
  if (!['transaction', 'address', 'token'].includes(type)) throw Error(`Type '${type}' is invalid.`)
  networkId = networkId === undefined ? String(getEthereumVariables.networkId()) : String(networkId)
  if (!Object.keys(networkDataById).includes(networkId)) throw Error(`Network id '${networkId}' is invalid.`)

  let prefix = networkDataById[networkId].etherscanPrefix
  var path
  if (type === 'transaction') {
    path = 'tx'
  } else if (type === 'address') {
    path = 'address'
  } else {
    path = 'token'
  }

  return `https://${prefix}etherscan.io/${path}/${data}`
}

module.exports = {
  _setEthereumVariableGetters: _setEthereumVariableGetters,
  signPersonal: signPersonal,
  signTypedData: signTypedData,
  getBalance: getBalance,
  getERC20Balance: getERC20Balance,
  getNetworkName: getNetworkName,
  getNetworkType: getNetworkType,
  getContract: getContract,
  sendTransaction: sendTransaction,
  toDecimal: toDecimal,
  fromDecimal: fromDecimal,
  etherscanFormat: etherscanFormat,
  libraries: {
    'eth-sig-util': ethSigUtil,
    'ethereumjs-util': ethUtil
  }
}
