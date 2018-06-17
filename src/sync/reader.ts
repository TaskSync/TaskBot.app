import AsyncMachine, { machine, PipeFlags } from 'asyncmachine'
import debug from 'debug'
import * as clone from 'deepcopy'
import * as diff from 'diff'
import * as moment from 'moment-timezone'
import { inspect } from 'util'
// Machine types
import {
  IBind,
  IEmit,
  IJSONStates,
  IState,
  TStates,
  IBindBase,
  IEmitBase,
  ITransitions
} from '../../typings/machines/sync/reader'
import { machineLogToDebug } from '../utils'
import Logger, { log_fn } from '../logger'
import RootSync, { DBRecord } from './root'

export { IState }

export const sync_reader_state: IJSONStates = {
  Enabled: {},

  Initializing: { require: ['Enabled'] },
  // TODO split to ReadyForReading, ReadyForWriting
  Ready: { auto: true, drop: ['Initializing'] },
  // optional
  ConfigSet: {},
  SubsReady: {},
  SubsInited: {},

  Reading: {
    drop: ['ReadingDone'],
    require: ['Enabled', 'Ready']
  },
  ReadingDone: {
    drop: ['Reading']
  },

  QuotaExceeded: {}
}
export type TSyncState = AsyncMachine<TStates, IBind, IEmit>

export abstract class SyncReader<GConfig, GStates, GBind, GEmit>
  implements ITransitions {
  state: AsyncMachine<any, any, any>
  get state_reader(): TSyncState {
    return this.state
  }
  active_requests: number
  // config: IConfig | null
  config: GConfig
  sub_states_inbound: [GStates | TStates, GStates | TStates][] = [
    ['ReadingDone', 'ReadingDone'],
    ['Ready', 'SubsReady']
  ]
  sub_states_outbound: [GStates | TStates, GStates | TStates][] = [
    ['Reading', 'Reading'],
    ['Enabled', 'Enabled']
  ]
  subs: {
    [index: string]: any
    // | Sync<any, TStates, IBind, IEmit>
    // | Sync<any, TStates, IBind, IEmit>[]
  } = {}
  root: RootSync

  last_read_end: moment.Moment
  last_read_start: moment.Moment
  last_read_time: moment.Duration

  log: log_fn
  log_error: log_fn
  log_verbose: log_fn

  quota_error: string | null
  quota_next_sync: number | null

  // TODO google specific
  // TODO use TimeArray, calculate the daily quota
  get daily_quota_ok() {
    const check =
      !this.quota_next_sync || this.quota_next_sync < moment().unix()
    // clean up
    if (check && this.quota_next_sync) {
      this.state.drop('QuotaExceeded')
      this.quota_next_sync = null
    }
    return check
  }

  get subs_flat(): SyncReader<GConfig, GStates, GBind, GEmit>[] {
    let ret = []
    for (const sub of Object.values(this.subs)) {
      if (Array.isArray(sub)) {
        ret.push(...sub)
      } else {
        ret.push(sub)
      }
    }
    return ret
  }

  constructor(config, root?: RootSync) {
    this.config = config
    // config and ConfigSet force us to do this here
    if (!root) {
      this.root = <RootSync>(<any>this)
      this.root.logger = new Logger()
    } else {
      this.root = root
    }
    this.state = this.getState()
    this.initLoggers()
    this.state.setTarget(this)
    this.state_reader.add('Initializing')
    if (process.env['DEBUG_AM'] || global.am_network) {
      machineLogToDebug(this.state_reader)
      if (global.am_network) {
        global.am_network.addMachine(this.state_reader)
      }
    }
    this.state_reader.add('ConfigSet', config)
  }

  // ----- -----
  // Transitions
  // ----- -----

  // TODO extract google specific code to GoogleAPIMixin
  Exception_enter(err, ...rest): boolean {
    this.log_error('ERROR: %O', err)
    if (err.errors) {
      let quota_err = false
      for (const error of err.errors) {
        if (error.domain == 'usageLimits') {
          this.state.add('QuotaExceeded', error.reason)
          quota_err = true
        }
      }
      if (quota_err) {
        return false
      }
    }
    if (this.root) {
      this.root.state.add('Exception', err, ...rest)
      return false
    }
  }

  // TODO extract google specific code to GoogleAPIMixin
  QuotaExceeded_state(reason: string) {
    this.quota_error = reason
    switch (reason) {
      case 'dailyLimitExceeded':
        // delay syncing per API endpoint until midnight PDF
        const next_sync = moment()
          .tz('America/Los_Angeles')
          .add(1, 'day')
          .startOf('day')
          .tz(moment.tz.guess())
          .unix()
        // TODO extract google specific code to GoogleAPIMixin
        // @ts-ignore
        if (this.gtasks) {
          // @ts-ignore
          this.gtasks.quota_next_sync = next_sync
          // @ts-ignore
        } else if (this.gmail) {
          // @ts-ignore
          this.gmail.quota_next_sync = next_sync
        } else {
          this.quota_next_sync = next_sync
        }
        break
    }
  }

  Enabled_state() {
    if (!this.state.is('Ready')) {
      this.state.add('Initializing')
    }
  }

  ConfigSet_state(config: GConfig) {
    this.config = config
  }

  SubsReady_enter() {
    return this.subs_flat.every(sync => sync.state.is('Ready'))
  }

  Reading_enter() {
    if (!this.daily_quota_ok) {
      this.log_error('Skipping sync because of quota')
      this.state.add('ReadingDone')
      return false
    }
  }

  Reading_state() {
    this.last_read_start = moment()
  }

  ReadingDone_enter() {
    return this.subs_flat.every(sync => sync.state.is('ReadingDone'))
  }

  ReadingDone_exit() {
    // prevent queued pipe mutations to switch ReadingDone back and forth
    const keep_reading_done =
      this.ReadingDone_enter() &&
      !(
        this.state.to().includes('Reading') ||
        this.state.to().includes('Writing')
      )
    return !keep_reading_done
  }

  ReadingDone_state() {
    this.last_read_end = moment()
    this.last_read_time = moment.duration(
      this.last_read_end.diff(this.last_read_start)
    )
  }

  // ----- -----
  // Methods
  // ----- -----

  getState() {
    return machine(sync_reader_state).id('SyncReader')
  }

  merge(): any[] {
    let ret = []
    for (const sub of this.subs_flat) {
      ret.push(...sub.merge())
    }
    return ret
  }

  bindToSubs() {
    for (const sync of this.subs_flat) {
      // inbound
      for (const [source, target] of this.sub_states_inbound) {
        sync.state.pipe(source, this.state, target)
      }
      // outbound
      for (const [source, target] of this.sub_states_outbound) {
        this.state.pipe(
          source,
          sync.state,
          target,
          PipeFlags.NEGOTIATION_ENTER | PipeFlags.FINAL_EXIT
        )
      }
    }
  }

  applyLabels(record: DBRecord, labels: { add?: string[]; remove?: string[] }) {
    record.labels = record.labels || {}
    for (const label of labels.remove || []) {
      // update the time only when something changes
      if (record.labels[label] && !record.labels[label].active) continue
      record.labels[label] = {
        active: false,
        updated: record.updated
      }
    }
    for (const label of labels.add || []) {
      // update the time only when something changes
      if (record.labels[label] && record.labels[label].active) continue
      record.labels[label] = {
        active: true,
        updated: record.updated
      }
    }
  }

  // TODO output to the logger, loose ID in the msg
  printRecordDiff(before, record, title = '') {
    if (!debug.enabled('record-diffs')) {
      return
    }
    if (JSON.stringify(before) == JSON.stringify(record)) {
      return
    }
    delete before.$loki
    delete before.meta
    const after = clone(record)
    delete after.$loki
    delete after.meta
    let msg = 'DB diff'
    if (title) {
      msg += ` '${title}'`
    }
    msg += ` from '${this.state.id()}'\n`
    for (const chunk of diff.diffChars(inspect(before), inspect(after))) {
      const color = chunk.added ? 'green' : chunk.removed ? 'red' : 'white'
      msg += chunk.value[color]
    }
    this.log(msg)
  }

  getMachines() {
    const machines = [this.state]
    for (const sub of this.subs_flat) {
      machines.push(...sub.getMachines())
    }
    return machines
  }

  initLoggers() {
    let name = this.state.id(true)

    this.log = this.root.logger.createLogger(name)
    this.log_verbose = this.root.logger.createLogger(name, 'verbose')
    this.log_error = this.root.logger.createLogger(name, 'error')
  }
}