import { machine } from 'asyncmachine'
import { gmail_v1 } from '../../../typings/googleapis/gmail'
// Machine types
import {
  AsyncMachine,
  IBind,
  IEmit,
  IJSONStates,
  TStates
} from '../../../typings/machines/google/gmail/query'
import { log_fn } from '../../app/logger'
import { machineLogToDebug } from '../../utils'
import GmailSync, { TThread } from './sync'

export const sync_state: IJSONStates = {
  Enabled: {},
  Dirty: {},

  FetchingThreads: {
    require: ['Enabled'],
    drop: ['ThreadsFetched', 'MsgsFetched']
  },
  ThreadsFetched: {
    require: ['Enabled'],
    drop: ['FetchingThreads']
  },

  FetchingMsgs: {
    require: ['Enabled', 'ThreadsFetched'],
    drop: ['MsgsFetched']
  },
  // TODO create a Ready state
  MsgsFetched: {
    require: ['Enabled'],
    drop: ['FetchingMsgs']
  },

  Exception: {
    drop: ['FetchingThreads', 'FetchingMsgs']
  }
}

export default class GmailQuery {
  state: AsyncMachine<TStates, IBind, IEmit>
  // history ID from the moment of reading
  history_id_synced: number | null
  threads: TThread[] = []
  prev_threads: TThread[] = []

  log: log_fn

  constructor(
    public gmail: GmailSync,
    public query: string,
    public name = '',
    public fetch_msgs = false
  ) {
    // TODO loose the cast
    this.state = <AsyncMachine<TStates, IBind, IEmit>>(
      (<any>machine(sync_state).id('Gmail/query: ' + this.name))
    )
    this.state.setTarget(this)

    this.log = this.gmail.root.logger.createLogger({
      name: this.state.id(true),
      user_id: gmail.config.user.id
    })

    // TODO avoid globals
    if (process.env['DEBUG_AM'] || global.am_network) {
      machineLogToDebug(
        gmail.root.logger,
        this.state,
        gmail.root.config.user.id
      )
      if (global.am_network) {
        global.am_network.addMachine(this.state)
      }
    }
  }

  // ----- -----
  // Transitions
  // ----- -----

  Exception_state(...params) {
    // TODO log errors per query, using this.log_error
    // forward the exception to the gmail class and effectively the root
    this.state.drop('Exception')
    this.gmail.state.add('Exception', ...params)
  }

  // ----- -----
  // Methods
  // ----- -----

  // TODO should download messages in parallel with next threads list pages
  async FetchingThreads_state() {
    let abort = this.state.getAbort('FetchingThreads')
    if (await this.isCached(abort)) {
      if (abort()) return
      this.log(`[CACHED] threads for '${this.query}'`)
      this.state.add('ThreadsFetched')
      if (this.fetch_msgs) {
        this.state.add('MsgsFetched')
      }
      return
    }
    if (abort()) return

    this.log(`[FETCH] threads list for '${this.query}'`)
    let results: TThread[] = []
    let prevRes: any
    while (true) {
      let params: gmail_v1.Params$Resource$Users$Threads$List = {
        maxResults: 1000,
        q: this.query,
        userId: 'me',
        // TODO is 'snippet' useful?
        // @ts-ignore
        fields: 'nextPageToken,threads(historyId,id)'
      }
      if (prevRes && prevRes.nextPageToken) {
        this.log(`[FETCH] next page for threads list for '${this.query}'`)
        params.pageToken = prevRes.nextPageToken
      }

      let list = await this.gmail.req(
        'users.threads.list',
        this.gmail.api.users.threads.list,
        this.gmail.api.users.threads,
        params,
        abort
      )
      if (!list) break
      if (abort()) return

      if (list.data.threads) {
        results.push(...list.data.threads)
      }

      if (!list.data.nextPageToken) break

      prevRes = list
    }

    // TODO could be done in parallel with downloading of the results
    let history_id = await this.gmail.getHistoryId(abort)
    if (abort()) return

    this.prev_threads = this.threads
    this.threads = results
    this.state.drop('Dirty')

    if (!this.fetch_msgs) {
      this.history_id_synced = history_id
    }

    this.state.add('ThreadsFetched')

    if (this.fetch_msgs) {
      abort = this.state.getAbort('ThreadsFetched')
      this.state.add('FetchingMsgs', history_id, abort)
    }
  }

  // TODO history_id is redundant
  async FetchingMsgs_state(history_id: number, abort?: () => boolean) {
    abort = this.state.getAbort('FetchingMsgs', abort)

    const threads_promises = this.threads.map(async (thread: TThread) => {
      // check if the thread has been previously downloaded and if
      // the history ID has changed
      const previous = this.gmail.threads.get(thread.id)
      if (!previous || previous.historyId != thread.historyId) {
        const refreshed = await this.gmail.fetchThread(
          thread.id,
          abort,
          'FetchingMsgs_state'
        )
        if (previous) {
          this.log(
            `History ID changed for thread '${this.gmail.getTitleFromThread(
              refreshed
            )}', re-fetched`
          )
        }
        return refreshed
      }
      return previous
    })

    const threads = await Promise.all(threads_promises)

    if (abort()) return

    // ensure all the requested threads were downloaded
    if (threads && threads.every(thread => Boolean(thread))) {
      this.history_id_synced = history_id
      this.threads = threads
      this.state.add('MsgsFetched')
    } else {
      // TODO retry the missing ones
      this.log('[FetchingMsgs] no results or some missing')
    }
  }

  Dirty_state() {
    this.history_id_synced = null
  }

  async isCached(abort: () => boolean): Promise<boolean | null> {
    if (this.state.is('Dirty')) {
      return false
    }
    return this.history_id_synced
      ? await this.gmail.isCached(this.history_id_synced, abort)
      : false
  }
}
