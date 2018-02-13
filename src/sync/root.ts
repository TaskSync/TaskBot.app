import GoogleSync from '../google/sync'
import { Semaphore } from 'await-semaphore'
import { Sync, SyncWriterState, SyncWriter } from './sync'
// import * as assert from 'assert/'
import * as Loki from 'lokijs'
import { promisify, promisifyArray } from 'typed-promisify-tob'
import * as moment from 'moment'
import { IConfig } from '../types'
import * as debug from 'debug'
import 'colors'
import * as diff from 'diff'

export class State extends SyncWriterState {
  SubsInited = {
    require: ['ConfigSet', 'DBReady'],
    auto: true,
    after: ['DBReady']
  }
  SubsReady = { require: ['SubsInited'], auto: true }
  Ready = {
    auto: true,
    require: ['ConfigSet', 'SubsReady', 'Enabled'],
    drop: ['Initializing'],
    add: ['Reading']
  }
  DBReady = { auto: true }

  constructor(target: RootSync) {
    super(target)
    this.registerAll()
  }
}

export type DB = LokiCollection<DBRecord>

/**
 * Local DB record format.
 */
export interface DBRecord {
  gmail_id?: DBRecordID
  title: string
  content: string
  updated: number
  parent?: DBRecordID
  labels: { [index: string]: DBRecordLabel }
  // different task ids per list
  gtasks_ids?: { [list_id: string]: string }
}

export type DBRecordID = string

export interface DBRecordLabel {
  // time
  updated: number
  // added or removed
  active: boolean
}

export default class RootSync extends SyncWriter {
  state: State
  subs: { [index: string]: Sync }

  max_active_requests = 5
  semaphore: Semaphore = new Semaphore(this.max_active_requests)
  active_requests = 0
  executed_requests: number

  last_read_end: moment.Moment
  last_read_start: moment.Moment
  last_read_time: moment.Duration
  last_write_end: moment.Moment
  last_write_start: moment.Moment
  last_write_time: moment.Duration

  // last_sync_start: number | null
  // last_sync_end: number | null
  // last_sync_time: number | null
  // next_sync_timeout: NodeJS.Timer | null

  db: Loki
  data: DB
  log = debug('root')
  log_requests = debug('requests')

  // TODO tmp
  last_db: string

  constructor(config: IConfig) {
    super(config)
  }

  // set history_id(history_id: number) {
  //   this.historyId = Math.max(this.history_id, history_id)
  //   this.addListener()
  // }

  // ----- -----
  // Transitions
  // ----- -----

  DBReady_state() {
    this.db = new Loki('gtd-bot')
    this.data = this.db.getCollection('todos') || this.db.addCollection('todos')
    this.data.toString = function() {
      return this.data
        .map((r: DBRecord) => {
          let ret = '- ' + r.title
          const snippet = r.content.replace(/\n/g, '')
          ret += snippet ? ` (${snippet})\n  ` : '\n  '
          ret += Object.entries(r.labels)
            .filter(([name, data]) => {
              return data.active
            })
            .map(([name, data]) => {
              return name
            })
            .join(', ')
          return ret
        })
        .join('\n')
    }
  }

  SubsInited_state() {
    // assert(this.config, this.datastore)
    // TODO map
    this.subs = {}
    this.subs.google = new GoogleSync(this)
    this.bindToSubs()
    // this.subs.google.state.add('Enabled')
  }

  Reading_state() {
    this.last_read_start = moment()
  }

  ReadingDone_state() {
    this.last_read_end = moment()
    this.last_read_time = moment.duration(
      this.last_read_end.diff(this.last_read_start)
    )
    this.merge()
    console.log(`DB read in ${this.last_read_time.asSeconds()}sec`)
    const db = this.data.toString() + '\n'
    // TODO tmp
    if (!this.last_db) {
      process.stderr.write(db)
    } else if (this.last_db && db != this.last_db) {
      for (const chunk of diff.diffChars(this.last_db, db)) {
        const color = chunk.added ? 'green' : chunk.removed ? 'red' : 'white'
        process.stderr.write(chunk.value[color])
      }
    }
    this.last_db = db
    this.state.add('Writing')
  }

  Writing_state() {
    this.last_write_start = moment()
  }

  WritingDone_state() {
    this.last_write_end = moment()
    this.last_write_time = moment.duration(
      this.last_write_end.diff(this.last_write_start)
    )
    this.log(
      `SYNC DONE:\nRead: ${this.last_read_time.asSeconds()}sec\n` +
        `Write: ${this.last_write_time.asSeconds()}sec`
    )
    setTimeout(
      this.state.addByListener('Reading'),
      this.config.sync_frequency * 1000
    )
  }

  // ----- -----
  // Methods
  // ----- -----

  // TODO take abort() as the second param
  async req<A, T, T2>(
    method: (arg: A, cb: (err: any, res: T, res2: T2) => void) => void,
    params: A,
    abort: (() => boolean) | null | undefined,
    returnArray: true,
    options?: object
  ): Promise<[T, T2] | null>
  async req<A, T>(
    method: (arg: A, cb: (err: any, res: T) => void) => void,
    params: A,
    abort: (() => boolean) | null | undefined,
    returnArray: false,
    options?: object
  ): Promise<T | null>
  async req<A, T>(
    method: (arg: A, cb: (err: any, res: T) => void) => void,
    params: A,
    abort: (() => boolean) | null | undefined,
    returnArray: boolean,
    options?: object
  ): Promise<any> {
    let release = await this.semaphore.acquire()
    if (abort && abort()) {
      release()
      return null
    }
    this.active_requests++

    if (!params) {
      params = {} as A
    }
    this.log_requests(`REQUEST (${this.active_requests} active): %O`, params)
    // TODO catch errors
    // TODO try util.promisify, type the return array manually
    let promise_method = returnArray
      ? promisifyArray(method)
      : promisify(method)
    // TODO googleapis specific code should be in google/sync.ts
    let ret = await promise_method(params, options)
    release()
    this.active_requests--
    this.log_requests('emit: request-finished')
    this.executed_requests++

    return ret
  }

  getState() {
    const state = new State(this)
    state.id('root')
    return state
  }

  merge() {
    let changes,
      c = 0
    const MAX = 10
    do {
      changes = this.subs_flat_writers.reduce((a, r) => {
        const changes = r.merge()
        if (changes) {
          a.push(...changes)
        }
        return a
      }, [])
      if (changes.length) {
        this.log('changes: %o', changes)
      }
    } while (changes.length && ++c < MAX)
    this.log(`SYNCED after ${c} rounds`)
    return []
  }
}