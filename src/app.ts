// import { Logger as LoggerRemote } from 'ami-logger/remote'
import { Logger, Network } from 'ami-logger'
import WorkerpoolMixin from 'ami-logger/logger/mixins/workerpool'
import { TAsyncMachine } from 'asyncmachine'
import 'source-map-support/register'
import settings_base from '../settings'
import settings_credentials from '../settings.credentials'
import create_repl from './repl'
import RootSync from './sync/root'
import { IConfig } from './types'

let root: RootSync
const settings = { ...settings_base, ...settings_credentials }

// TODO make it less global
function init_am_inspector(machines?: TAsyncMachine[]) {
  global.am_network = new Network()
  // TODO types for the options param
  const WorkerLogger = WorkerpoolMixin(Logger)
  global.am_logger = new WorkerLogger(global.am_network, {
    granularity: 1
  })
  global.am_logger.start()
  if (machines) {
    for (const machine of machines) {
      global.am_network.addMachine(machine)
    }
  }
}

if (process.env['DEBUG_AMI']) {
  init_am_inspector()
}

process.on('SIGINT', exit)
process.on('exit', exit)

console.log('Starting the sync service...')
root = new RootSync((<any>settings) as IConfig)
root.state.add('Enabled')

let exit_printed = false
function exit(err?) {
  if (exit_printed) return
  if (global.am_network) {
    const filename = err.name
      ? 'logs/snapshot-exception.json'
      : 'logs/snapshot.json'
    global.am_logger.saveFile(filename)
    console.log(`Saved a snapshot to ${filename}`)
  }
  for (const machine of root.getMachines()) {
    console.log(machine.statesToString(true))
  }
  if (root.data) {
    console.log(root.data.toString())
  }
  exit_printed = true
  process.exit()
}

// create_repl(root, init_am_inspector, settings.repl_port)
