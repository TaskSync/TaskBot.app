import 'source-map-support/register'
import settings from '../settings'
import settings_debug from '../settings-debug'
import ManagerSync from "./root/sync"
import { Logger, Network } from 'ami-logger/remote'
import * as util from 'util'

// const app_settings = process.env['DEBUG'] ? settings_debug : settings
const app_settings = settings_debug

if (process.env['DEBUG']) {
  // TODO make it less global
  global.am_network = new Network()
  global.am_logger = new Logger(global.am_network)
}

const root = new ManagerSync(app_settings)
root.state.add('Enabled')

if (process.env['DEBUG']) {
  process.on('uncaughtException', function(err) {
    console.error(err)
    process.exit()
  })
  process.on('SIGINT', function(err) {
    process.exit()
  })
  process.on('exit', function(err) {
    console.log('exit...')
    global.am_logger.saveFile('snapshot.json')
    console.log('Saved a snapshot to snapshot.json')
    // console.log(util.inspect(root.data.data, {depth: 10}))
    console.log(global.am_network.toString())
    console.log(root.data.toString())
    process.exit()
  })
}
